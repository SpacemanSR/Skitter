'use strict';
/* Text extraction for the file types Gofer indexes. Pure JS, no native modules. */
const fs = require('fs');
const path = require('path');

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.rst', '.csv', '.tsv', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.log', '.tex', '.xml',
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.gd', '.php', '.sql', '.sh', '.bat', '.ps1', '.css', '.scss', '.lua', '.swift', '.kt', '.srt', '.vtt', '.fountain', '.org', '.nfo']);
const HTML_EXT = new Set(['.html', '.htm', '.xhtml']);
const ZIP_XML_EXT = new Set(['.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods']);
const SUPPORTED = new Set([...TEXT_EXT, ...HTML_EXT, ...ZIP_XML_EXT, '.pdf', '.rtf']);

const SIZE_LIMITS = { '.pdf': 25 * 1024 * 1024, default: 8 * 1024 * 1024 };

function isSupported(ext) { return SUPPORTED.has(ext); }
function sizeLimit(ext) { return SIZE_LIMITS[ext] || SIZE_LIMITS.default; }

function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+));/gi, (m, name, dec, hex) => {
    if (dec) return String.fromCodePoint(parseInt(dec, 10));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name.toLowerCase()] || m;
  });
}
function stripTags(xml) {
  return decodeEntities(xml.replace(/<[^>]+>/g, ' ')).replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function xmlToText(xml, paragraphTags) {
  let s = xml;
  for (const tag of paragraphTags) s = s.replace(new RegExp('</' + tag + '>', 'g'), '\n');
  s = s.replace(/<(w:tab|w:br|a:br)\b[^>]*\/?>/g, ' ');
  return stripTags(s);
}

function readZipXml(filePath, maxChars) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const entries = zip.getEntries();
  const byName = new Map(entries.map((e) => [e.entryName, e]));
  const read = (name) => { const e = byName.get(name); return e ? e.getData().toString('utf8') : ''; };
  let text = '';
  if (ext === '.docx') {
    text = xmlToText(read('word/document.xml'), ['w:p']);
    const extra = [];
    for (const [name] of byName) if (/^word\/(header|footer|footnotes|comments)\d*\.xml$/.test(name)) extra.push(xmlToText(read(name), ['w:p']));
    if (extra.length) text += '\n' + extra.join('\n');
  } else if (ext === '.pptx') {
    const slides = [...byName.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
    const parts = [];
    for (const n of slides) { parts.push(xmlToText(read(n), ['a:p'])); if (parts.join('\n').length > maxChars) break; }
    const notes = [...byName.keys()].filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
    for (const n of notes) { if (parts.join('\n').length > maxChars) break; parts.push(xmlToText(read(n), ['a:p'])); }
    text = parts.join('\n');
  } else if (ext === '.xlsx') {
    const shared = read('xl/sharedStrings.xml');
    const strings = []; const re = /<t(?:\s[^>]*)?>([^<]*)<\/t>/g; let m;
    while ((m = re.exec(shared)) && strings.join(' ').length < maxChars) strings.push(decodeEntities(m[1]));
    const wb = read('xl/workbook.xml'); const names = []; const re2 = /<sheet\b[^>]*\bname="([^"]*)"/g;
    while ((m = re2.exec(wb))) names.push(decodeEntities(m[1]));
    text = names.join('\n') + '\n' + strings.join(' ');
  } else { // odt / odp / ods
    text = xmlToText(read('content.xml'), ['text:p', 'text:h', 'table:table-row']);
  }
  return text;
}

/* pdf.js setup that works in plain Node and inside Electron's background process (where it otherwise assumes a browser) */
let pdfReady = false;
function PDF() {
  // pdf.js touches these at load time, so they must exist before require('pdf-parse')
  if (!pdfReady) { try { const cv = require('@napi-rs/canvas'); for (const k of ['DOMMatrix', 'ImageData', 'Path2D']) if (!globalThis[k] && cv[k]) globalThis[k] = cv[k]; } catch (e) {} }
  // pdf.js treats Electron's background process as a browser (no DOM, so drawing fails). It is plain Node here:
  // let pdf.js see that while it loads, then restore the real value.
  let restore = null;
  if (!pdfReady && process.versions.electron && process.type && process.type !== 'browser') {
    const d = Object.getOwnPropertyDescriptor(process, 'type');
    try { Object.defineProperty(process, 'type', { value: 'browser', configurable: true, writable: true }); restore = () => Object.defineProperty(process, 'type', d); } catch (e) {}
  }
  let PDFParse;
  try { ({ PDFParse } = require('pdf-parse')); } finally { if (restore) try { restore(); } catch (e) {} }
  if (!pdfReady) {
    pdfReady = true;
    try { const { pathToFileURL } = require('url'); PDFParse.setWorker(pathToFileURL(path.join(path.dirname(require.resolve('pdf-parse')), 'pdf.worker.mjs')).href); } catch (e) {}
  }
  return PDFParse;
}

async function readPdf(filePath, maxChars) {
  const PDFParse = PDF();
  const buf = fs.readFileSync(filePath);
  const maxPages = Math.max(4, Math.ceil(maxChars / 2500));
  const parser = new PDFParse({ data: buf });
  try {
    const r = await parser.getText({ last: maxPages });
    return (r && r.text ? r.text : '').replace(/\n-- \d+ of \d+ --\n/g, '\n');
  } finally { try { await parser.destroy(); } catch (e) {} }
}

function readRtf(filePath) {
  const s = fs.readFileSync(filePath, 'latin1');
  return s.replace(/\\par[d]?\b/g, '\n').replace(/\\'[0-9a-f]{2}/g, ' ').replace(/\\[a-zA-Z]+-?\d* ?/g, '').replace(/[{}]/g, '').replace(/[ \t]+/g, ' ').trim();
}

function readHtml(filePath) {
  const s = fs.readFileSync(filePath, 'utf8');
  return stripTags(s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<\/(p|div|h\d|li|tr|br)>/gi, '\n'));
}

/* Returns the text of a file (truncated to maxChars), or '' when it can't be read. Never throws. */
async function extractText(filePath, maxChars) {
  const ext = path.extname(filePath).toLowerCase();
  maxChars = maxChars || 60000;
  try {
    let text = '';
    if (TEXT_EXT.has(ext)) text = fs.readFileSync(filePath, 'utf8');
    else if (HTML_EXT.has(ext)) text = readHtml(filePath);
    else if (ZIP_XML_EXT.has(ext)) text = readZipXml(filePath, maxChars);
    else if (ext === '.pdf') text = await readPdf(filePath, maxChars);
    else if (ext === '.rtf') text = readRtf(filePath);
    else return '';
    if (text.length > maxChars) text = text.slice(0, maxChars);
    // drop binary-looking content (wrong encodings, embedded blobs)
    if (/\u0000/.test(text.slice(0, 2000))) return '';
    return text;
  } catch (e) {
    return '';
  }
}

module.exports = { extractText, isSupported, sizeLimit, SUPPORTED, PDF };
