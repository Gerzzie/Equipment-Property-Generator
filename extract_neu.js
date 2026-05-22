// Extract Neutralino .neu bundle (asar-style).
//
// Layout (verified against neutralinojs/resources.cpp):
//   bytes 0-3    : 4 (magic / size-of-size; ignored by parser)
//   bytes 4-7    : padded_json_size + 8
//   bytes 8-11   : padded_json_size + 4
//   bytes 12-15  : unpadded JSON byte length
//   bytes 16..   : JSON file-map string (UTF-8), no padding bytes IN the JSON
//   then         : 0-3 bytes of NUL padding so the file blob is 4-byte aligned
//   then         : file-data blob; each file at the offset stored in JSON
//
// Each directory entry: { "files": { <name>: <entry>, ... } }
// Each file entry:      { size, offset, integrity }  (integrity is unused by Neutralino runtime)
const fs = require('fs');
const path = require('path');

const NEU_PATH = path.join(__dirname, 'resources.neu');
const OUT_DIR  = path.join(__dirname, 'extracted');

const buf = fs.readFileSync(NEU_PATH);

// Read the unpadded JSON length from bytes 12-15 (uint32 LE)
const jsonSize = buf.readUInt32LE(12);
const jsonStart = 16;
const jsonEnd   = jsonStart + jsonSize;
// File data blob begins after 4-byte alignment
const blobStart = (jsonEnd + 3) & ~3;

const meta = JSON.parse(buf.slice(jsonStart, jsonEnd).toString('utf8'));

console.log('JSON size:', jsonSize, ' blob starts at:', blobStart, ' total:', buf.length);

fs.mkdirSync(OUT_DIR, { recursive: true });

function walk(node, dirAbs) {
    fs.mkdirSync(dirAbs, { recursive: true });
    for (const [name, entry] of Object.entries(node)) {
        const target = path.join(dirAbs, name);
        if (entry && typeof entry === 'object' && 'files' in entry) {
            walk(entry.files, target);
        } else if (entry && typeof entry === 'object' && 'size' in entry) {
            const off = parseInt(entry.offset);
            const fileBuf = buf.slice(blobStart + off, blobStart + off + entry.size);
            fs.writeFileSync(target, fileBuf);
            console.log('  +', path.relative(OUT_DIR, target), '(', entry.size, 'bytes)');
        }
    }
}

walk(meta.files, OUT_DIR);
console.log('Done.');
