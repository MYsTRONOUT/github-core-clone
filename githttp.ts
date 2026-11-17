// githttp.ts — git smart HTTP: upload-pack (v2 and v0) and receive-pack (v0).
//
// The wire format here is git's own: pkt-line framing, v2 capabilities and
// sections, v0 advertisements with the `# service=` preamble, sideband
// band-1 pack chunks, and the report-status lines a push expects. Repos are
// created through REST only; a push to a missing repo is 404 and the server
// stays up.

import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLines,
  isObjectId,
  parseCommit,
  parseTag,
  readPack,
  writePack,
} from './gitcore.ts';
import type { GitObject } from './gitcore.ts';
import type { Repo } from './forge.ts';
import { sendBuffer, sendError } from './http.ts';
import type { Ctx } from './http.ts';

const AGENT = 'github-core-clone/1.0';
const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const MAX_SIDEBAND_DATA = 65515;

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
}

/** Every ref of a repo, sorted by name, with peeled targets for annotated tags. */
function listRefLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const tag = parseTag(object.data);
      if (isObjectId(tag.object)) line.peeled = tag.object;
    }
    lines.push(line);
  }
  return lines;
}

/** The HEAD line for advertisements and ls-refs. */
function headLine(repo: Repo): RefLine {
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return { oid: head ?? ZERO_OID, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` };
}

function formatRefLine(line: RefLine): string {
  const attrs: string[] = [];
  if (line.symrefTarget !== undefined) attrs.push(`symref-target:${line.symrefTarget}`);
  if (line.peeled !== undefined) attrs.push(`peeled:${line.peeled}`);
  return attrs.length > 0 ? `${line.oid} ${line.name} ${attrs.join(' ')}\n` : `${line.oid} ${line.name}\n`;
}

// ---------------------------------------------------------------- advertisements

function uploadPackAdvertisementV2(): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

function uploadPackAdvertisementV0(repo: Repo): Buffer {
  const capabilities = [
    'multi_ack',
    'thin-pack',
    'side-band',
    'side-band-64k',
    'ofs-delta',
    'shallow',
    'deepen-since',
    'deepen-not',
    'deepen-relative',
    'no-progress',
    'include-tag',
    'multi_ack_detailed',
    'allow-tip-sha1-in-want',
    'allow-reachable-sha1-in-want',
    'no-done',
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
    `agent=${AGENT}`,
  ].join(' ');
  const lines: (string | 'flush')[] = [`# service=git-upload-pack\n`, 'flush'];
  const refs = listRefLines(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`);
  } else {
    const head = headLine(repo);
    lines.push(`${head.oid} HEAD\u0000${capabilities}\n`);
    for (const ref of refs) {
      lines.push(formatRefLine(ref));
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function receivePackAdvertisementV0(repo: Repo): Buffer {
  const capabilities = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`].join(' ');
  const lines: (string | 'flush')[] = [`# service=git-receive-pack\n`, 'flush'];
  const refs = listRefLines(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`);
  } else {
    lines.push(`${refs[0]?.oid ?? ZERO_OID} ${refs[0]?.name ?? ''}\u0000${capabilities}\n`);
    for (const ref of refs.slice(1)) lines.push(formatRefLine(ref));
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** GET /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack */
export function handleInfoRefs(ctx: Ctx, repo: Repo): void {
  const service = ctx.query.get('service') ?? '';
  const wantsV2 = (ctx.req.headers['git-protocol'] ?? '') === 'version=2';
  if (service === 'git-upload-pack') {
    if (wantsV2) sendBuffer(ctx, 200, UPLOAD_ADVERTISEMENT, uploadPackAdvertisementV2());
    else sendBuffer(ctx, 200, UPLOAD_ADVERTISEMENT, uploadPackAdvertisementV0(repo));
    return;
  }
  if (service === 'git-receive-pack') {
    sendBuffer(ctx, 200, RECEIVE_ADVERTISEMENT, receivePackAdvertisementV0(repo));
    return;
  }
  sendError(ctx, 400, 'unknown service');
}

// ---------------------------------------------------------------- fetch planning

interface FetchPlan {
  objects: GitObject[];
  shallowOut: string[];
  unshallowOut: string[];
  wantedRefs: { oid: string; name: string }[];
}

/**
 * What a fetch sends: every object reachable from the wants, minus what the
 * client already holds (its haves and its shallow boundary), depth-limited on
 * commit ancestry, plus the new shallow boundary and the refs the wants point at.
 */
function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallow: string[],
  depth: number | undefined,
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const shallowSet = new Set(shallow);
  const haveSet = new Set<string>();
  // What the client already holds. A have normally implies its whole
  // ancestry — except when it is also a declared shallow boundary: a shallow
  // clone holds the boundary commit and its tree and blobs, but NOT its
  // parents, so such a have contributes only the commit and its tree closure.
  const addTreeClosureTo = (set: Set<string>, treeOid: string): void => {
    for (const child of collectReachable([treeOid], lookup, { allowMissing: true })) set.add(child);
  };
  const addBoundaryTo = (set: Set<string>, oid: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined) return;
    set.add(oid);
    if (object.type === 'commit') {
      const tree = parseCommitData(object.data);
      if (tree !== null) addTreeClosureTo(set, tree);
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject !== undefined && targetObject.type === 'commit') {
        set.add(target);
        const tree = parseCommitData(targetObject.data);
        if (tree !== null) addTreeClosureTo(set, tree);
      }
    }
  };
  for (const oid of haves) {
    if (shallowSet.has(oid)) {
      addBoundaryTo(haveSet, oid);
      continue;
    }
    try {
      for (const reached of collectReachable([oid], lookup, { allowMissing: true })) haveSet.add(reached);
    } catch {
      // A missing have is the client's problem; keep going with what we have.
    }
  }
  // The client's shallow boundary: the boundary commits and their trees and
  // blobs, but not their parents.
  for (const oid of shallow) addBoundaryTo(haveSet, oid);

  // Walk the wants with a depth budget (depth 1 = the tips only), tracking each
  // commit's generation from a want so the boundary is exact.
  const tagObjects: string[] = [];
  const budget = depth === undefined ? Number.POSITIVE_INFINITY : depth;
  const reachable = new Map<string, number>();
  const stack: { oid: string; depth: number }[] = [];
  const stackSeen = new Set<string>();
  const pushStack = (oid: string, depth: number): void => {
    const key = `${oid}:${depth}`;
    if (stackSeen.has(key)) return;
    stackSeen.add(key);
    stack.push({ oid, depth });
  };
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagObjects.push(want);
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject !== undefined && targetObject.type === 'commit') pushStack(target, 0);
    } else if (object.type === 'commit') {
      pushStack(want, 0);
    } else {
      tagObjects.push(want);
    }
  }
  while (stack.length > 0) {
    const { oid, depth } = stack.pop() as { oid: string; depth: number };
    if (depth >= budget) continue;
    const known = reachable.get(oid);
    if (known !== undefined && known <= depth) continue;
    reachable.set(oid, depth);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) pushStack(parent, depth + 1);
  }

  const boundary = new Set<string>();
  if (depth !== undefined) {
    for (const [oid, depthAt] of reachable) {
      if (depthAt !== depth - 1) continue;
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit' && parseCommit(object.data).parents.length > 0) {
        boundary.add(oid);
      }
    }
  }

  // The send set is built from the depth-limited walk, NOT from a full
  // reachability expansion: each commit in `reachable` contributes itself
  // plus its own tree closure (trees and blobs only — a tree never names a
  // parent commit), so a depth-1 fetch sends the tip and its files and
  // nothing older. (A full collectReachable here would re-expand the whole
  // ancestry and defeat the depth budget.)
  const sendSet = new Set<string>();
  const addTreeClosure = (treeOid: string): void => {
    for (const child of collectReachable([treeOid], lookup, { allowMissing: true })) sendSet.add(child);
  };
  for (const oid of reachable.keys()) {
    sendSet.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const tree = parseCommitData(object.data);
    if (tree !== null) addTreeClosure(tree);
  }
  // Wanted tags and non-commit objects: the object itself, plus a tag's
  // target closure (a tag to a commit is already covered through `reachable`;
  // a tag to a tree or blob sends that target's closure too).
  for (const oid of tagObjects) {
    sendSet.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject === undefined) continue;
      if (targetObject.type === 'commit') {
        const tree = parseCommitData(targetObject.data);
        if (tree !== null) addTreeClosure(tree);
      } else if (targetObject.type === 'tree') {
        addTreeClosure(target);
      } else {
        sendSet.add(target);
      }
    } else if (object.type === 'tree') {
      addTreeClosure(oid);
    }
  }
  for (const oid of haveSet) sendSet.delete(oid);

  const objects: GitObject[] = [];
  for (const oid of [...sendSet].sort()) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }

  const shallowOut = [...boundary].filter((oid) => !haveSet.has(oid)).sort();
  const unshallowOut = shallow.filter((oid) => reachable.has(oid)).sort();

  const wantedRefs: { oid: string; name: string }[] = [];
  for (const want of wants) {
    for (const [name, oid] of repo.refs) {
      if (oid === want) wantedRefs.push({ oid, name });
    }
  }
  wantedRefs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { objects, shallowOut, unshallowOut, wantedRefs };
}

function parseCommitData(data: Buffer): string | null {
  try {
    return parseCommit(data).tree;
  } catch {
    return null;
  }
}

/** Split bytes into sideband band-1 pkt-lines (data <= 65,515 bytes each). */
function sidebandData(data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += MAX_SIDEBAND_DATA) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + MAX_SIDEBAND_DATA));
    parts.push(encodePktLines([Buffer.concat([Buffer.from([1]), chunk])]));
  }
  return parts;
}

/** Split a pack into sideband band-1 pkt-lines (data <= 65,515 bytes each). */
function sidebandPack(pack: Buffer): Buffer[] {
  return sidebandData(pack);
}

// ---------------------------------------------------------------- upload-pack

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function parseFetchArgs(lines: string[]): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    const [verb, ...rest] = line.split(' ');
    const arg = rest.join(' ');
    if (verb === 'want' && isObjectId(arg)) wants.push(arg);
    else if (verb === 'have' && isObjectId(arg)) haves.push(arg);
    else if (verb === 'shallow' && isObjectId(arg)) shallow.push(arg);
    else if (verb === 'deepen' && /^\d+$/.test(arg)) depth = Number(arg);
    else if (verb === 'deepen-since' || verb === 'deepen-not') depth = undefined;
    // agent, object-format, thin-pack, no-progress, ofs-delta, filter, done: ignored.
  }
  return { wants, haves, shallow, depth };
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(ctx: Ctx, repo: Repo): void {
  const wantsV2 = (ctx.req.headers['git-protocol'] ?? '') === 'version=2';
  let packets;
  try {
    packets = decodePktLines(ctx.body);
  } catch {
    sendError(ctx, 400, 'malformed pkt-line stream');
    return;
  }
  const lines: string[] = [];
  let command: string | undefined;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    if (wantsV2 && text.startsWith('command=')) command = text.slice('command='.length).trim();
    else lines.push(text);
  }

  if (wantsV2 && command === 'ls-refs') {
    const prefixes: string[] = [];
    let peel = false;
    let symrefs = false;
    for (const raw of lines) {
      const line = raw.replace(/\n$/, '');
      if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
      else if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
    }
    const out: (string | 'flush')[] = [];
    const head = headLine(repo);
    const refs = listRefLines(repo);
    const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    // The HEAD line is a ref like any other: it is listed when it matches a
    // requested prefix (a clone asks for "HEAD" among its prefixes), and left
    // out when no prefix matches it.
    if (matches('HEAD')) {
      if (head.oid === ZERO_OID) {
        // An unborn HEAD is the literal word "unborn", not a zero oid.
        out.push(symrefs ? `unborn HEAD symref-target:${head.symrefTarget}\n` : 'unborn HEAD\n');
      } else {
        const headLineOut: RefLine = { ...head };
        if (!symrefs) delete headLineOut.symrefTarget;
        out.push(formatRefLine(headLineOut));
      }
    }
    for (const ref of refs) {
      if (!matches(ref.name)) continue;
      const line: RefLine = { ...ref };
      if (!peel) delete line.peeled;
      out.push(formatRefLine(line));
    }
    out.push('flush');
    sendBuffer(ctx, 200, 'application/x-git-upload-pack-result', encodePktLines(out));
    return;
  }

  if (wantsV2 && command !== undefined && command !== 'fetch') {
    sendError(ctx, 400, `unsupported command ${command}`);
    return;
  }

  const fetch = parseFetchArgs(lines);
  const plan = planFetch(repo, fetch.wants, fetch.haves, fetch.shallow, fetch.depth);
  const pack = writePack(plan.objects);

  if (wantsV2) {
    // Protocol v2 answers in sections, each opened by a header line and closed
    // by a delim; the packfile section is opened by "packfile" and closed by a
    // flush. The acknowledgments section only exists when the client sent
    // haves to negotiate against — a fresh clone gets no ack section at all,
    // exactly as a real git server answers it.
    const parts: Buffer[] = [];
    if (fetch.haves.length > 0) {
      parts.push(encodePktLines(['acknowledgments\n', 'NAK\n', 'delim']));
    }
    if (plan.shallowOut.length > 0 || plan.unshallowOut.length > 0) {
      const shallowLines: string[] = ['shallow-info\n'];
      for (const oid of plan.shallowOut) shallowLines.push(`shallow ${oid}\n`);
      for (const oid of plan.unshallowOut) shallowLines.push(`unshallow ${oid}\n`);
      shallowLines.push('delim');
      parts.push(encodePktLines(shallowLines));
    }
    parts.push(encodePktLines(['packfile\n']));
    parts.push(...sidebandPack(pack));
    parts.push(encodePktLines(['flush']));
    sendBuffer(ctx, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return;
  }

  // v0: ack lines, then shallow lines, then the sideband pack, then flush.
  const v0Lines: string[] = ['NAK\n'];
  for (const oid of plan.shallowOut) v0Lines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallowOut) v0Lines.push(`unshallow ${oid}\n`);
  const parts: Buffer[] = [encodePktLines(v0Lines), ...sidebandPack(pack), encodePktLines(['flush'])];
  sendBuffer(ctx, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(ctx: Ctx, repo: Repo): void {
  // The request is commands (pkt-lines) + flush, then the packfile. The pack
  // is a raw stream, but tolerate a sideband-framed pack as well.
  let flushIndex = -1;
  let offset = 0;
  const commands: PushCommand[] = [];
  let packStart = ctx.body.length;
  try {
    while (offset < ctx.body.length) {
      if (offset + 4 > ctx.body.length) throw new Error('truncated pkt-line');
      const head = ctx.body.subarray(offset, offset + 4).toString('ascii');
      if (head === '0000') {
        flushIndex = offset;
        packStart = offset + 4;
        break;
      }
      if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('bad pkt-line length');
      const length = parseInt(head, 16);
      if (length < 4 || offset + length > ctx.body.length) throw new Error('pkt-line out of range');
      const line = ctx.body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
      // The first command line carries the negotiated capabilities after a NUL;
      // they are not part of the ref name.
      const nul = line.indexOf('\u0000');
      const commandText = nul < 0 ? line : line.slice(0, nul);
      const parts = commandText.split(' ');
      if (parts.length >= 3 && isObjectId(parts[0] as string) && isObjectId(parts[1] as string)) {
        commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
      }
      offset += length;
    }
  } catch {
    sendError(ctx, 400, 'malformed receive-pack stream');
    return;
  }
  if (flushIndex < 0) {
    sendError(ctx, 400, 'receive-pack has no flush after its commands');
    return;
  }

  const packBytes = ctx.body.subarray(packStart);
  let objects: Map<string, GitObject> | null = null;
  if (packBytes.length > 0) {
    if (packBytes.subarray(0, 4).toString('ascii') === 'PACK') {
      try {
        objects = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      } catch (err) {
        sendError(ctx, 400, `pack did not read: ${(err as Error).message}`);
        return;
      }
    } else {
      // Sideband-framed pack: band-1 payloads concatenated.
      try {
        const packets = decodePktLines(packBytes);
        const chunks: Buffer[] = [];
        for (const packet of packets) {
          if (packet.kind === 'data' && packet.payload.length > 0 && packet.payload[0] === 1) {
            chunks.push(packet.payload.subarray(1));
          }
        }
        const joined = Buffer.concat(chunks);
        if (joined.length > 0) objects = readPack(joined, { resolveBase: (oid) => repo.objects.get(oid) });
      } catch (err) {
        sendError(ctx, 400, `pack did not read: ${(err as Error).message}`);
        return;
      }
    }
  }
  if (objects !== null) {
    for (const [oid, object] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else if (!repo.objects.has(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: the ref must be at oldOid and newOid must descend from it.
    if (current === undefined || current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    let fastForward = false;
    try {
      const reachable = collectReachable([command.newOid], (oid) => repo.objects.get(oid), { allowMissing: true });
      fastForward = reachable.has(command.oldOid);
    } catch {
      fastForward = false;
    }
    if (!fastForward) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  const reportLines: string[] = ['unpack ok\n'];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  // The report-status stream is itself pkt-lined inside band 1: each status
  // line is its own pkt-line within the band-1 payload, and the stream ends
  // with its own flush — exactly as a real git receive-pack sends it. (The
  // outer flush after the band-1 packet closes the response itself.)
  const reportFramed = encodePktLines([...reportLines, 'flush']);
  const parts: Buffer[] = [...sidebandData(reportFramed), encodePktLines(['flush'])];
  sendBuffer(ctx, 200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
}
