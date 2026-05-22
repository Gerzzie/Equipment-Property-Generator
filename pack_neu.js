// Repack a directory tree into a Neutralino .neu bundle.
//
// Source layout (after running extract_neu.js):
//   extracted/
//     neutralino.config.json
//     resources/
//       index.html, styles.css, ...
//       icons/ ...
//       js/ ...
//
// Output:   resources.neu (next to extract_neu.js)
//
// Bundle layout (matches Neutralino runtime parser):
//   bytes 0-3   : 0x00000004  (magic; runtime ignores)
//   bytes 4-7   : padded_json_size + 8   (LE uint32)
//   bytes 8-11  : padded_json_size + 4   (LE uint32)
//   bytes 12-15 : unpadded_json_size     (LE uint32)
//   bytes 16..  : JSON file-map (UTF-8) then 0-3 NUL bytes for 4-byte alignment
//   then        : concatenated file blob; offset in JSON = position inside blob

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SRC_DIR = path.join(__dirname, 'extracted');
const OUT_NEU = path.join(__dirname, 'resources.neu');

const BLOCK_SIZE = 4194304; // 4 MiB — matches what Neutralino's bundler emits

function sha256Integrity(data) {
    const fullHash = crypto.createHash('sha256').update(data).digest('hex');
    const blocks = [];
    for (let i = 0; i < data.length; i += BLOCK_SIZE) {
        blocks.push(crypto.createHash('sha256').update(data.slice(i, i + BLOCK_SIZE)).digest('hex'));
    }
    if (blocks.length === 0) blocks.push(fullHash);
    return { algorithm: 'SHA256', hash: fullHash, blockSize: BLOCK_SIZE, blocks };
}

// Walk SRC_DIR depth-first, collect all file paths.
function collectFiles(dirAbs, relPrefix) {
    const out = [];
    const entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
        const childAbs = path.join(dirAbs, e.name);
        const childRel = relPrefix ? relPrefix + '/' + e.name : e.name;
        if (e.isDirectory()) {
            out.push(...collectFiles(childAbs, childRel));
        } else if (e.isFile()) {
            out.push({ relPath: childRel, absPath: childAbs });
        }
    }
    return out;
}

// Build the nested {files:{<dir>:{files:{...}}, <file>:{size,offset,integrity}}} structure.
function buildHeaderJson(files, blobBuilder) {
    const root = { files: {} };
    let cursor = 0;
    for (const f of files) {
        const data = fs.readFileSync(f.absPath);
        const parts = f.relPath.split('/');
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const segment = parts[i];
            node.files[segment] = node.files[segment] || { files: {} };
            node = node.files[segment];
        }
        const fname = parts[parts.length - 1];
        node.files[fname] = {
            size: data.length,
            offset: String(cursor),
            integrity: sha256Integrity(data),
        };
        cursor += data.length;
        blobBuilder.push(data);
    }
    return root;
}

function main() {
    const files = collectFiles(SRC_DIR, '');
    console.log('Packing', files.length, 'files...');

    const blobParts = [];
    const headerObj = buildHeaderJson(files, blobParts);
    const headerJson = Buffer.from(JSON.stringify(headerObj), 'utf8');
    const unpaddedSize = headerJson.length;
    const paddedSize   = (unpaddedSize + 3) & ~3;
    const padBytes     = paddedSize - unpaddedSize;

    const head = Buffer.alloc(16);
    head.writeUInt32LE(4,                0);   // magic
    head.writeUInt32LE(paddedSize + 8,   4);
    head.writeUInt32LE(paddedSize + 4,   8);
    head.writeUInt32LE(unpaddedSize,     12);

    const blob = Buffer.concat(blobParts);
    const padding = Buffer.alloc(padBytes); // zeros

    const out = Buffer.concat([head, headerJson, padding, blob]);
    fs.writeFileSync(OUT_NEU, out);

    console.log('  JSON:', unpaddedSize, 'bytes (padded to', paddedSize + ')');
    console.log('  Blob:', blob.length, 'bytes');
    console.log('  Wrote', OUT_NEU, '-', out.length, 'bytes');
}

main();
