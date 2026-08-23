// src/app/BinaryWriter.ts

export class BinaryWriter {
    private view: DataView;
    private buf: Uint8Array;
    private pos = 0;

    constructor(size: number) {
        this.buf = new Uint8Array(size);
        this.view = new DataView(this.buf.buffer);
    }

    writeUInt8(value: number): this {
        this.view.setUint8(this.pos, value);
        this.pos += 1;
        return this;
    }

    writeInt8(value: number): this {
        this.view.setInt8(this.pos, value);
        this.pos += 1;
        return this;
    }

    writeUInt16BE(value: number): this {
        this.view.setUint16(this.pos, value);
        this.pos += 2;
        return this;
    }

    writeInt16BE(value: number): this {
        this.view.setInt16(this.pos, value);
        this.pos += 2;
        return this;
    }

    writeUInt32BE(value: number): this {
        this.view.setUint32(this.pos, value);
        this.pos += 4;
        return this;
    }

    writeInt32BE(value: number): this {
        this.view.setInt32(this.pos, value);
        this.pos += 4;
        return this;
    }

    writeUInt32LE(value: number): this {
        this.view.setUint32(this.pos, value, true);
        this.pos += 4;
        return this;
    }

    writeBigUInt64BE(value: bigint): this {
        this.view.setBigUint64(this.pos, value);
        this.pos += 8;
        return this;
    }

    writeBytes(data: Uint8Array): this {
        this.buf.set(data, this.pos);
        this.pos += data.length;
        return this;
    }

    writeString(text: string): this {
        const encoded = new TextEncoder().encode(text);
        this.buf.set(encoded, this.pos);
        this.pos += encoded.length;
        return this;
    }

    writeBytesAt(offset: number, data: Uint8Array): this {
        this.buf.set(data, offset);
        return this;
    }

    get offset(): number {
        return this.pos;
    }

    toUint8Array(): Uint8Array {
        return this.buf.subarray(0, this.pos);
    }
}
