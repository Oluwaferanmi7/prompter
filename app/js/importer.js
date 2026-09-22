// Turn a file from the phone into a script. Plain text / Markdown as-is; Word .docx is
// unzipped and its paragraphs pulled out right here (no libraries, works offline).

export const ACCEPT = '.txt,.md,.markdown,.text,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export async function fileToScript(file) {
  const name = file.name || 'Imported';
  const title = name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Imported';
  const ext = (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  let text;
  if (ext === 'docx' || file.type.includes('wordprocessingml')) text = await docxText(await file.arrayBuffer());
  else if (ext === 'doc' || ext === 'pages' || ext === 'pdf' || ext === 'rtf') throw new Error(`.${ext} isn't supported — export it as Word (.docx) or plain text first`);
  else text = await file.text();
  text = String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[  ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) throw new Error(`${name} has no text in it`);
  return { title, text };
}

// ---------------------------------------------------------------- .docx
async function docxText(buf) {
  const xml = await unzipEntry(new Uint8Array(buf), 'word/document.xml');
  if (!xml) throw new Error("That doesn't look like a Word file");
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const paras = doc.getElementsByTagNameNS(W, 'p');
  const out = [];
  for (const p of paras) {
    let s = '';
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue;
        if (c.namespaceURI !== W) {
          walk(c);
          continue;
        }
        if (c.localName === 't') s += c.textContent;
        else if (c.localName === 'tab') s += ' ';
        else if (c.localName === 'br' || c.localName === 'cr') s += '\n';
        else walk(c);
      }
    };
    walk(p);
    out.push(s);
  }
  return out.join('\n');
}

// Minimal ZIP reader: central directory → one entry, inflated with the browser's
// built-in DecompressionStream (iOS 16.4+, Chrome, Firefox).
async function unzipEntry(bytes, wanted) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory record (scan back past a possible comment)
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) return null;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== wanted) continue;
    const lNameLen = dv.getUint16(local + 26, true);
    const lExtraLen = dv.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(start, start + compSize);
    if (method === 0) return dec.decode(data);
    if (method !== 8) throw new Error('Unsupported Word file compression');
    if (typeof DecompressionStream === 'undefined') throw new Error('This phone is too old to read Word files here — use plain text');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(stream).text();
  }
  return null;
}
