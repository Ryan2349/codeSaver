/**
 * 零依賴 ZIP 檔案產生器（STORE 模式，不壓縮）
 * 產生標準 ZIP 格式，可被任何解壓工具開啟
 */

// CRC-32 查表法
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c;
    }
    return table;
})();

function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function strToUint8(str) {
    return new TextEncoder().encode(str);
}

function dosDateTime(date) {
    const d = date || new Date();
    const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
    const dateVal = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
    return { time, date: dateVal };
}

function writeUint16(arr, offset, value) {
    arr[offset] = value & 0xFF;
    arr[offset + 1] = (value >> 8) & 0xFF;
}

function writeUint32(arr, offset, value) {
    arr[offset] = value & 0xFF;
    arr[offset + 1] = (value >> 8) & 0xFF;
    arr[offset + 2] = (value >> 16) & 0xFF;
    arr[offset + 3] = (value >> 24) & 0xFF;
}

/**
 * 建立 ZIP 檔案的 Blob
 * @param {Array<{path: string, content: string, isFolder?: boolean}>} entries
 * @returns {Blob}
 */
export function createZipBlob(entries) {
    const now = new Date();
    const { time: dosTime, date: dosDate } = dosDateTime(now);

    const localHeaders = [];
    const centralHeaders = [];
    let offset = 0;

    // 建立每個條目的 Local File Header + 資料
    for (const entry of entries) {
        const nameBytes = strToUint8(entry.path);
        const contentBytes = entry.isFolder ? new Uint8Array(0) : strToUint8(entry.content || '');
        const crc = crc32(contentBytes);
        const size = contentBytes.length;

        // Local File Header: 30 bytes + name length
        const localHeader = new Uint8Array(30 + nameBytes.length);
        writeUint32(localHeader, 0, 0x04034b50);   // signature
        writeUint16(localHeader, 4, 20);            // version needed
        writeUint16(localHeader, 6, 0);             // flags
        writeUint16(localHeader, 8, 0);             // compression: STORE
        writeUint16(localHeader, 10, dosTime);      // mod time
        writeUint16(localHeader, 12, dosDate);      // mod date
        writeUint32(localHeader, 14, crc);          // crc-32
        writeUint32(localHeader, 18, size);         // compressed size
        writeUint32(localHeader, 22, size);         // uncompressed size
        writeUint16(localHeader, 26, nameBytes.length); // name length
        writeUint16(localHeader, 28, 0);            // extra field length
        localHeader.set(nameBytes, 30);

        localHeaders.push({ header: localHeader, data: contentBytes, offset });

        // Central Directory Header: 46 bytes + name length
        const centralHeader = new Uint8Array(46 + nameBytes.length);
        writeUint32(centralHeader, 0, 0x02014b50);  // signature
        writeUint16(centralHeader, 4, 20);           // version made by
        writeUint16(centralHeader, 6, 20);           // version needed
        writeUint16(centralHeader, 8, 0);            // flags
        writeUint16(centralHeader, 10, 0);           // compression: STORE
        writeUint16(centralHeader, 12, dosTime);     // mod time
        writeUint16(centralHeader, 14, dosDate);     // mod date
        writeUint32(centralHeader, 16, crc);         // crc-32
        writeUint32(centralHeader, 20, size);        // compressed size
        writeUint32(centralHeader, 24, size);        // uncompressed size
        writeUint16(centralHeader, 28, nameBytes.length); // name length
        writeUint16(centralHeader, 30, 0);           // extra field length
        writeUint16(centralHeader, 32, 0);           // comment length
        writeUint16(centralHeader, 34, 0);           // disk number start
        writeUint16(centralHeader, 36, 0);           // internal attrs
        writeUint32(centralHeader, 38, entry.isFolder ? 0x10 : 0x20); // external attrs
        writeUint32(centralHeader, 42, offset);      // local header offset
        centralHeader.set(nameBytes, 46);

        centralHeaders.push(centralHeader);

        offset += localHeader.length + contentBytes.length;
    }

    // End of Central Directory Record
    const centralDirOffset = offset;
    let centralDirSize = 0;
    centralHeaders.forEach(h => centralDirSize += h.length);

    const eocd = new Uint8Array(22);
    writeUint32(eocd, 0, 0x06054b50);              // signature
    writeUint16(eocd, 4, 0);                        // disk number
    writeUint16(eocd, 6, 0);                        // disk with central dir
    writeUint16(eocd, 8, entries.length);           // entries on this disk
    writeUint16(eocd, 10, entries.length);          // total entries
    writeUint32(eocd, 12, centralDirSize);          // central dir size
    writeUint32(eocd, 16, centralDirOffset);        // central dir offset
    writeUint16(eocd, 20, 0);                       // comment length

    // 組合所有部分
    const parts = [];
    for (const { header, data } of localHeaders) {
        parts.push(header, data);
    }
    for (const ch of centralHeaders) {
        parts.push(ch);
    }
    parts.push(eocd);

    return new Blob(parts, { type: 'application/zip' });
}