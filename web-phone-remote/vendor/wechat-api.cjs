"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/server/wechat/standalone.ts
var standalone_exports = {};
__export(standalone_exports, {
  handleWechatRequest: () => handleWechatRequest
});
module.exports = __toCommonJS(standalone_exports);
var import_child_process = require("child_process");
var import_fs2 = require("fs");
var import_promises3 = require("fs/promises");
var import_http = require("http");
var import_path2 = __toESM(require("path"));

// src/server/wechat/deviceOps.ts
var import_crypto2 = require("crypto");
var import_promises2 = require("fs/promises");
var import_os = __toESM(require("os"));
var import_path = __toESM(require("path"));

// src/server/wechat/Xhb.ts
var import_crypto = require("crypto");
var import_fs = require("fs");
var import_promises = require("fs/promises");
var import_events = require("events");
var import_zlib = require("zlib");
var CRYPTO_MAGIC = Buffer.from("XHWB0001", "ascii");
var BUNDLE_MAGIC = Buffer.from("XHBP0002", "ascii");
var CHUNK = 65536;
var MAX_PLAINTEXT = 512 * 1024 * 1024;
var MAX_ARCHIVE = 1024 * 1024 * 1024;
var MAX_EXPANDED = 2 * 1024 * 1024 * 1024;
var MAX_ENTRIES = 2e5;
var CORE_PATHS = "files/recovery_v3 files/KeyInfo.bin files/kvcomm files/kvcomm-push files/mmkv files/psk.key. files/Heartbeat.ini files/tlsregion.ini files/wasae.dat files/NativeCDNInfo files/identity_records MicroMsg/autoauth.cfg MicroMsg/deviceconfig.cfg MicroMsg/systemInfo.cfg MicroMsg/CompatibleInfo.cfg MicroMsg/channel_history.cfg MicroMsg/mobileinfo.ini MicroMsg/version_history.cfg MicroMsg/heavy_user_id_mapping.dat MicroMsg/recovery shared_prefs databases account.bin".split(" ");
var ACCOUNT_DIR = /^MicroMsg\/([0-9a-fA-F]{32})(\/.*)?$/;
var FileByteReader = class _FileByteReader {
  constructor(handle) {
    this.handle = handle;
  }
  handle;
  position = 0;
  static async open(path3) {
    return new _FileByteReader(await (0, import_promises.open)(path3, "r"));
  }
  async exact(size) {
    if (size === 0) return Buffer.alloc(0);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await this.handle.read(buffer, offset, size - offset, this.position + offset);
      if (bytesRead === 0) throw new Error("\u5907\u4EFD\u6587\u4EF6\u88AB\u622A\u65AD");
      offset += bytesRead;
    }
    this.position += size;
    return buffer;
  }
  /** Read exactly `size` bytes, or return null at a clean EOF. */
  async tryExact(size) {
    if (size === 0) return Buffer.alloc(0);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await this.handle.read(buffer, offset, size - offset, this.position + offset);
      if (bytesRead === 0) {
        if (offset === 0) return null;
        throw new Error("\u5907\u4EFD\u6587\u4EF6\u88AB\u622A\u65AD");
      }
      offset += bytesRead;
    }
    this.position += size;
    return buffer;
  }
  async close() {
    await this.handle.close();
  }
};
var StreamByteReader = class {
  chunks = [];
  buffered = 0;
  ended = false;
  iterator;
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
  }
  async fill(target) {
    while (this.buffered < target && !this.ended) {
      const { value, done } = await this.iterator.next();
      if (done) {
        this.ended = true;
        break;
      }
      const chunk = value;
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
  }
  async exact(size) {
    if (size === 0) return Buffer.alloc(0);
    await this.fill(size);
    if (this.buffered < size) throw new Error("\u5907\u4EFD\u5185\u5BB9\u4E0D\u5B8C\u6574");
    const out = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const head = this.chunks[0];
      const take = Math.min(head.length, size - offset);
      head.copy(out, offset, 0, take);
      offset += take;
      this.buffered -= take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    return out;
  }
  async skip(size) {
    let remaining = size;
    while (remaining > 0) {
      await this.fill(1);
      if (this.chunks.length === 0) throw new Error("\u5907\u4EFD\u5185\u5BB9\u4E0D\u5B8C\u6574");
      const head = this.chunks[0];
      const take = Math.min(head.length, remaining);
      remaining -= take;
      this.buffered -= take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
  }
  /** Any remaining decompressed byte must be tar padding (zero). */
  async expectPaddingOnly() {
    for (; ; ) {
      const { value, done } = await this.iterator.next();
      if (done) return;
      const chunk = value;
      for (const byte of chunk) if (byte !== 0) throw new Error("\u5907\u4EFD\u5C3E\u90E8\u542B\u5F02\u5E38\u6570\u636E");
    }
  }
};
function int32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
}
function deriveKey(password, salt) {
  return (0, import_crypto.pbkdf2Sync)(Buffer.from(password, "utf8"), salt, 21e4, 32, "sha256");
}
async function writeAll(out, chunk) {
  if (!out.write(chunk)) await (0, import_events.once)(out, "drain");
}
async function finishStream(out) {
  out.end();
  await (0, import_events.once)(out, "finish");
}
async function decryptXhb(source, target, password) {
  if (password.length < 10) throw new Error("\u5907\u4EFD\u5BC6\u7801\u81F3\u5C1110\u4F4D");
  const reader = await FileByteReader.open(source);
  const out = (0, import_fs.createWriteStream)(target);
  try {
    const header = await reader.exact(32);
    if (!header.subarray(0, 8).equals(CRYPTO_MAGIC)) throw new Error("\u4E0D\u662F\u53D7\u652F\u6301\u7684\u5FAE\u4FE1\u4E91\u5907\u4EFD");
    const key = deriveKey(password, header.subarray(8, 24));
    let index = 0;
    let total = 0;
    for (; ; ) {
      const length = (await reader.exact(4)).readInt32BE(0);
      if (length < 0 || length > CHUNK) throw new Error("\u5907\u4EFD\u5185\u5BB9\u957F\u5EA6\u5F02\u5E38");
      total += length;
      if (total > MAX_PLAINTEXT) throw new Error("\u5907\u4EFD\u8D85\u8FC7512MB");
      const blob = await reader.exact(length + 16);
      const nonce = Buffer.concat([header.subarray(24, 32), int32(index)]);
      const aad = Buffer.concat([header, int32(index), int32(length)]);
      const decipher = (0, import_crypto.createDecipheriv)("aes-256-gcm", key, nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(blob.subarray(length, length + 16));
      const plain = Buffer.concat([decipher.update(blob.subarray(0, length)), decipher.final()]);
      if (plain.length) await writeAll(out, plain);
      if (length === 0) {
        const trailing = await reader.tryExact(1);
        if (trailing) throw new Error("\u5907\u4EFD\u5C3E\u90E8\u542B\u5F02\u5E38\u6570\u636E");
        break;
      }
      index += 1;
    }
    await finishStream(out);
  } catch (error) {
    out.destroy();
    throw error instanceof Error && /unable to authenticate|bad decrypt|Unsupported state/i.test(error.message) ? new Error("\u5907\u4EFD\u5BC6\u7801\u4E0D\u6B63\u786E\u6216\u6587\u4EF6\u5DF2\u635F\u574F") : error;
  } finally {
    await reader.close();
  }
}
async function unpackBundle(bundle, archive) {
  const reader = await FileByteReader.open(bundle);
  const out = (0, import_fs.createWriteStream)(archive);
  try {
    const magic = await reader.exact(8);
    if (magic[0] === 31 && magic[1] === 139) {
      await writeAll(out, magic);
      for (; ; ) {
        const rest = await reader.tryExact(CHUNK);
        if (!rest) break;
        await writeAll(out, rest);
      }
      await finishStream(out);
      return null;
    }
    if (!magic.equals(BUNDLE_MAGIC)) throw new Error("\u5907\u4EFD\u683C\u5F0F\u4E0D\u53D7\u652F\u6301");
    const metadataLength = (await reader.exact(4)).readInt32BE(0);
    if (metadataLength < 2 || metadataLength > 32768) throw new Error("\u5907\u4EFD\u8BF4\u660E\u957F\u5EA6\u65E0\u6548");
    let metadata;
    try {
      metadata = JSON.parse((await reader.exact(metadataLength)).toString("utf8"));
    } catch {
      throw new Error("\u5907\u4EFD\u8BF4\u660E\u5185\u5BB9\u65E0\u6548");
    }
    const archiveLength = Number((await reader.exact(8)).readBigInt64BE(0));
    if (!Number.isSafeInteger(archiveLength) || archiveLength < 20 || archiveLength > MAX_ARCHIVE) {
      throw new Error("\u5907\u4EFD\u5F52\u6863\u957F\u5EA6\u65E0\u6548");
    }
    let remaining = archiveLength;
    while (remaining > 0) {
      const chunk = await reader.tryExact(Math.min(CHUNK, remaining));
      if (!chunk) throw new Error("\u5907\u4EFD\u5F52\u6863\u88AB\u622A\u65AD");
      await writeAll(out, chunk);
      remaining -= chunk.length;
    }
    await finishStream(out);
    return metadata;
  } catch (error) {
    out.destroy();
    throw error;
  } finally {
    await reader.close();
  }
}
function headerString(header, offset, max) {
  let end = offset;
  while (end < offset + max && header[end] !== 0) end += 1;
  return header.subarray(offset, end).toString("utf8");
}
function headerOctal(header, offset, max) {
  const value = headerString(header, offset, max).trim();
  if (value.length === 0) return 0;
  if (!/^[0-7]+$/.test(value)) throw new Error("\u5907\u4EFD\u6587\u4EF6\u5934\u65E0\u6548");
  return Number.parseInt(value, 8);
}
async function validateArchive(archive) {
  const gunzip = (0, import_zlib.createGunzip)();
  const source = (0, import_fs.createReadStream)(archive);
  source.on("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  const reader = new StreamByteReader(gunzip);
  const roots = /* @__PURE__ */ new Set();
  let hasDatabase = false;
  let hasPrefs = false;
  let ended = false;
  let expanded = 0;
  let longName = null;
  try {
    for (let entries = 0; entries < MAX_ENTRIES; entries += 1) {
      const header = await reader.exact(512);
      let zero = true;
      for (const byte of header) {
        if (byte !== 0) {
          zero = false;
          break;
        }
      }
      if (zero) {
        ended = true;
        break;
      }
      const checksum = headerOctal(header, 148, 8);
      let actual = 0;
      for (let i = 0; i < 512; i += 1) actual += i >= 148 && i < 156 ? 32 : header[i];
      if (checksum !== actual) throw new Error("\u5907\u4EFD\u76EE\u5F55\u6821\u9A8C\u5931\u8D25");
      const size = headerOctal(header, 124, 12);
      expanded += size;
      if (size < 0 || expanded > MAX_EXPANDED) throw new Error("\u5907\u4EFD\u5C55\u5F00\u5927\u5C0F\u8D85\u8FC72GB");
      const type = header[156];
      let name = headerString(header, 0, 100);
      const prefix = headerString(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
      if (type === 76) {
        if (longName !== null || size > 4096) throw new Error("\u5907\u4EFD\u957F\u6587\u4EF6\u540D\u5F02\u5E38");
        longName = headerString(await reader.exact(size), 0, size);
        await reader.skip((512 - size % 512) % 512);
        continue;
      }
      if (longName !== null) {
        name = longName;
        longName = null;
      }
      if (type !== 0 && type !== 48 && type !== 53) {
        throw new Error("\u5907\u4EFD\u5305\u542B\u4E0D\u652F\u6301\u7684\u94FE\u63A5\u6216\u7279\u6B8A\u6587\u4EF6");
      }
      while (name.startsWith("./")) name = name.slice(2);
      if (name.startsWith("/") || name.includes("\\") || name.includes("\n") || name.includes("\r")) {
        throw new Error("\u5907\u4EFD\u8DEF\u5F84\u975E\u6CD5");
      }
      for (const part of name.split("/")) {
        if (part === ".." || part === ".") throw new Error("\u5907\u4EFD\u8DEF\u5F84\u8D8A\u754C");
      }
      let root = null;
      for (const allowed of CORE_PATHS) {
        if (name === allowed || name.startsWith(`${allowed}/`)) {
          root = allowed;
          break;
        }
      }
      const account = ACCOUNT_DIR.exec(name);
      if (root === null && account) root = name.slice(0, 41);
      if (root === null) throw new Error("\u5907\u4EFD\u542B\u975E\u5FAE\u4FE1\u6838\u5FC3\u8DEF\u5F84");
      roots.add(root);
      if (type !== 53 && ACCOUNT_DIR.test(name) && /^MicroMsg\/[0-9a-fA-F]{32}\/EnMicroMsg\.db$/.test(name) && size > 0) {
        hasDatabase = true;
      }
      if (type !== 53 && name.startsWith("shared_prefs/") && size > 0) hasPrefs = true;
      await reader.skip(size + (512 - size % 512) % 512);
    }
    if (!ended || longName !== null) throw new Error("\u5907\u4EFD\u76EE\u5F55\u4E0D\u5B8C\u6574");
    await reader.expectPaddingOnly();
  } catch (error) {
    gunzip.destroy();
    throw error;
  }
  if (!hasDatabase || !hasPrefs) throw new Error("\u5907\u4EFD\u7F3A\u5C11\u804A\u5929\u5E93\u6216\u8D26\u53F7\u914D\u7F6E\uFF0C\u4E0D\u80FD\u6062\u590D");
  return roots;
}
async function sha256File(path3) {
  return new Promise((resolve, reject) => {
    const hash = (0, import_crypto.createHash)("sha256");
    const stream = (0, import_fs.createReadStream)(path3);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
async function encryptXhb(source, target, password) {
  if (password.length < 10) throw new Error("\u5907\u4EFD\u5BC6\u7801\u81F3\u5C1110\u4F4D");
  const header = (0, import_crypto.randomBytes)(32);
  CRYPTO_MAGIC.copy(header, 0);
  const key = deriveKey(password, header.subarray(8, 24));
  const out = (0, import_fs.createWriteStream)(target);
  const input = (0, import_fs.createReadStream)(source, { highWaterMark: CHUNK });
  try {
    await writeAll(out, header);
    let index = 0;
    let carry = Buffer.alloc(0);
    for await (const chunk of input) {
      carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      while (carry.length >= CHUNK) {
        const block = carry.subarray(0, CHUNK);
        carry = carry.subarray(CHUNK);
        await writeEncryptedBlock(out, key, header, index, block, 0, block.length);
        index += 1;
      }
    }
    if (carry.length) {
      await writeEncryptedBlock(out, key, header, index, carry, 0, carry.length);
      index += 1;
    }
    await writeEncryptedBlock(out, key, header, index, Buffer.alloc(0), 0, 0);
    await finishStream(out);
  } catch (error) {
    out.destroy();
    throw error;
  }
}
async function writeEncryptedBlock(out, key, header, index, block, offset, length) {
  const nonce = Buffer.concat([header.subarray(24, 32), int32(index)]);
  const aad = Buffer.concat([header, int32(index), int32(length)]);
  const cipher = (0, import_crypto.createCipheriv)("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(block.subarray(offset, offset + length)), cipher.final(), cipher.getAuthTag()]);
  const size = Buffer.alloc(4);
  size.writeInt32BE(length, 0);
  await writeAll(out, size);
  await writeAll(out, encrypted);
}
async function packBundle(archive, target, metadata) {
  const json = Buffer.from(JSON.stringify(metadata), "utf8");
  if (json.length > 32768) throw new Error("\u5907\u4EFD\u8BF4\u660E\u8FC7\u957F");
  const info = await (0, import_promises.stat)(archive);
  if (info.size < 20) throw new Error("\u5907\u4EFD\u5F52\u6863\u4E3A\u7A7A");
  const out = (0, import_fs.createWriteStream)(target);
  try {
    await writeAll(out, BUNDLE_MAGIC);
    const length = Buffer.alloc(4);
    length.writeInt32BE(json.length, 0);
    await writeAll(out, length);
    await writeAll(out, json);
    const size = Buffer.alloc(8);
    size.writeBigInt64BE(BigInt(info.size), 0);
    await writeAll(out, size);
    const input = (0, import_fs.createReadStream)(archive, { highWaterMark: 1 << 20 });
    for await (const chunk of input) await writeAll(out, chunk);
    await finishStream(out);
  } catch (error) {
    out.destroy();
    throw error;
  }
}
function backupScript(archiveRemote) {
  return `set -eu
umask 077
B=/data/user/0/com.tencent.mm
F=${archiveRemote}
P="$F.part"
STOPPED=0
finish() {
  code=$?
  trap - EXIT
  rm -f "$P"
  if [ "$STOPPED" = 1 ]; then echo WECHAT_PAUSED; fi
  exit "$code"
}
trap finish EXIT
test -d "$B" || { echo '\u65E0\u6CD5\u8BBF\u95EE\u5FAE\u4FE1\u6570\u636E\u76EE\u5F55'; exit 21; }
mkdir -p "\${F%/*}"
cd "$B"
wxid=$(grep -h -o 'wxid_[A-Za-z0-9_-]*' shared_prefs/*.xml 2>/dev/null | head -n1 || true)
uin=$(sed -n 's/.*name="default_uin" value="\\([-0-9]*\\)".*/\\1/p' shared_prefs/system_config_prefs.xml 2>/dev/null | head -n1 || true)
echo "WXID:$wxid"
echo "UIN:$uin"
set --
ACCOUNTS=0
for d in MicroMsg/*; do
  if [ -s "$d/EnMicroMsg.db" ]; then set -- "$@" "$d"; ACCOUNTS=$((ACCOUNTS+1)); fi
done
[ "$ACCOUNTS" -gt 0 ] && [ -d shared_prefs ] || { echo '\u8BF7\u5148\u767B\u5F55\u5FAE\u4FE1\uFF0C\u672A\u627E\u5230\u8D26\u53F7\u5E93'; exit 22; }
for f in ${CORE_PATHS.join(" ")}; do
  if [ -e "$f" ]; then set -- "$@" "$f"; fi
done
echo 'XH_PROGRESS:\u6B65\u9AA4 1/3 \xB7 \u6B63\u5728\u6682\u505C\u5FAE\u4FE1'
STOPPED=1
am force-stop com.tencent.mm
sleep 1
echo 'XH_PROGRESS:\u6B65\u9AA4 2/3 \xB7 \u6B63\u5728\u6253\u5305\u5FAE\u4FE1\u6570\u636E\uFF0C\u8BF7\u7A0D\u5019'
tar -czf "$P" "$@"
echo 'XH_PROGRESS:\u6B65\u9AA4 3/3 \xB7 \u6B63\u5728\u6821\u9A8C\u5F52\u6863'
test -s "$P"
tar -tzf "$P" >/dev/null
chmod 644 "$P"
mv "$P" "$F"
echo BACKUP_OK
`;
}
function restoreScript(uid, archiveRemote, workRemote) {
  return `set -eu
umask 077
B=/data/user/0/com.tencent.mm
A=${archiveRemote}
W=${workRemote}
U=${uid}
STOPPED=0
CLEARED=0
DONE=0
ROLLBACK_OK=1
test -d "$B" && test ! -L "$B" || { echo '\u5FAE\u4FE1\u6570\u636E\u76EE\u5F55\u4E0D\u53EF\u7528\uFF0C\u672A\u6E05\u7406'; exit 21; }
rm -rf "$W"
mkdir -p "$W/stage" "$W/previous"
finish() {
  code=$?
  trap - EXIT
  set +e
  if [ "$STOPPED" = 1 ] && [ "$DONE" = 0 ]; then
    if [ "$CLEARED" = 1 ]; then
      for p in "$B"/* "$B"/.[!.]* "$B"/..?*; do
        [ -e "$p" ] || [ -L "$p" ] || continue
        [ "\${p##*/}" = lib ] && continue
        rm -rf "$p" || ROLLBACK_OK=0
      done
    fi
    for p in "$W/previous"/* "$W/previous"/.[!.]* "$W/previous"/..?*; do
      [ -e "$p" ] || [ -L "$p" ] || continue
      mv "$p" "$B/\${p##*/}" || ROLLBACK_OK=0
    done
    if [ "$ROLLBACK_OK" = 1 ]; then echo ROLLBACK_OK; else echo 'ROLLBACK_FAILED\uFF1A\u8BF7\u52FF\u64CD\u4F5C\u5FAE\u4FE1\uFF0C\u4FDD\u7559\u56DE\u6EDA\u76EE\u5F55'; fi
  fi
  [ "$STOPPED" = 1 ] && echo WECHAT_PAUSED
  if [ "$DONE" = 1 ] || [ "$STOPPED" = 0 ]; then rm -rf "$W"; else echo "\u56DE\u6EDA\u8BB0\u5F55\u4FDD\u7559\u5728 $W"; fi
  exit "$code"
}
trap finish EXIT
echo 'XH_PROGRESS:\u6B65\u9AA4 1/4 \xB7 \u6B63\u5728\u89E3\u5305\u5230\u6682\u5B58\u76EE\u5F55\uFF0C\u5C1A\u672A\u6E05\u7406\u5FAE\u4FE1'
tar -xzf "$A" -C "$W/stage"
chown -R "$U":"$U" "$W/stage"
STOPPED=1
am force-stop com.tencent.mm
sleep 1
echo 'XH_PROGRESS:\u6B65\u9AA4 2/4 \xB7 \u6B63\u5728\u6682\u5B58\u5E76\u6E05\u7406\u65E7\u6570\u636E'
for p in "$B"/* "$B"/.[!.]* "$B"/..?*; do
  [ -e "$p" ] || [ -L "$p" ] || continue
  [ "\${p##*/}" = lib ] && continue
  mv "$p" "$W/previous/\${p##*/}"
done
CLEARED=1
echo CLEAN_DATA_OK
echo 'XH_PROGRESS:\u6B65\u9AA4 3/4 \xB7 \u6B63\u5728\u8FD8\u539F\u5907\u4EFD\u5E76\u4FEE\u590D\u6743\u9650'
for p in "$W/stage"/*; do
  [ -e "$p" ] || continue
  f="\${p##*/}"
  mv "$p" "$B/$f"
  restorecon -R "$B/$f"
done
DONE=1
echo 'XH_PROGRESS:\u6B65\u9AA4 4/4 \xB7 \u8FD8\u539F\u5B8C\u6210\uFF0C\u6B63\u5728\u6E05\u7406\u6682\u5B58\u76EE\u5F55'
echo RESTORE_OK
`;
}

// src/server/wechat/deviceOps.ts
var REMOTE_DIR = "/data/local/tmp/xh-wechat";
var BACKUP_TIMEOUT = 10 * 6e4;
var RESTORE_TIMEOUT = 15 * 6e4;
var ROBOT_DB_DIR = "/data/data/com.wechat.stats";
var WECHAT_DIR = "/data/user/0/com.tencent.mm";
var ROOT_CACHE_TTL = 5 * 6e4;
var BST_SERVICE = "com.bluestacks.BstCommandProcessor/.BstCommandProcessorService";
var BST_ACTION = "execRootCmdSilent";
var BST_DIR = "/sdcard/.xh";
var rootCache = /* @__PURE__ */ new Map();
function tail(value, limit = 4e3) {
  return value.length > limit ? value.slice(-limit) : value;
}
function maskA16(value) {
  const text = typeof value === "string" ? value : "";
  return /^A[0-9a-f]{15}$/.test(text) ? `${text.slice(0, 4)}\u2026${text.slice(-4)}` : "";
}
function detectImage(buffer) {
  if (buffer.length > 8 && buffer[0] === 137 && buffer[1] === 80 && buffer[2] === 78 && buffer[3] === 71) return "png";
  if (buffer.length > 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "jpg";
  if (buffer.length > 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}
async function openSqlite(file) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}
async function runViaBst(adb2, serial, command, timeoutMs) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const scriptPath = `${BST_DIR}/${id}.sh`;
  const outPath = `${BST_DIR}/${id}.out`;
  const codePath = `${BST_DIR}/${id}.code`;
  const local = import_path.default.join(import_os.default.tmpdir(), `xh-bst-${id}.sh`);
  await (0, import_promises2.writeFile)(local, command, "utf8");
  try {
    await adb2.shell(serial, `mkdir -p ${BST_DIR}`, 5e3);
    await adb2.push(serial, local, scriptPath);
    const inner = `sh ${scriptPath} > ${outPath} 2>&1; echo \\$? > ${codePath}`;
    await adb2.shell(serial, `am startservice -n ${BST_SERVICE} -a ${BST_ACTION} --es cmd "${inner}"`, 15e3);
    const deadline = Date.now() + timeoutMs;
    let code = "";
    for (; ; ) {
      try {
        code = (await adb2.shell(serial, `cat ${codePath} 2>/dev/null`, 5e3)).trim();
      } catch {
        code = "";
      }
      if (/^\d+$/.test(code)) break;
      if (Date.now() > deadline) throw new Error("\u8BBE\u5907 root \u547D\u4EE4\u6267\u884C\u8D85\u65F6");
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    try {
      return await adb2.shell(serial, `cat ${outPath} 2>/dev/null`, Math.min(timeoutMs, 6e4));
    } catch {
      return "";
    }
  } finally {
    await (0, import_promises2.rm)(local, { force: true }).catch(() => void 0);
    await adb2.shell(serial, `rm -f ${scriptPath} ${outPath} ${codePath}`, 5e3).catch(() => void 0);
  }
}
async function runRoot(adb2, serial, root, command, timeoutMs = 3e4) {
  if (root.mode === "su") return adb2.shell(serial, `su -c '${command}'`, timeoutMs);
  if (root.mode === "adb") return adb2.shell(serial, command, timeoutMs);
  if (root.mode === "bst") return runViaBst(adb2, serial, command, timeoutMs);
  throw new Error(`\u8BBE\u5907\u6CA1\u6709\u53EF\u7528\u7684 root\uFF1A${root.detail}`);
}
async function probeRoot(adb2, serial) {
  let suPath = "";
  try {
    suPath = (await adb2.shell(serial, "which su 2>/dev/null", 5e3)).trim();
  } catch {
    suPath = "";
  }
  let suFailure = "";
  if (suPath) {
    try {
      const output = await adb2.shell(serial, "su -c id 2>&1", 15e3);
      if (/uid=0/.test(output)) return { mode: "su", detail: "\u5DF2\u6388\u6743 su" };
      suFailure = "su \u5B58\u5728\u4F46\u65E0\u6CD5\u63D0\u6743\uFF08\u53EF\u80FD\u662F\u6B8B\u7559 su \u6216\u5C1A\u672A\u5728 root \u7BA1\u7406\u5668\u4E2D\u6388\u6743 shell\uFF09";
    } catch {
      suFailure = "su \u672A\u54CD\u5E94\uFF08\u53EF\u80FD\u6B63\u5728\u7B49\u5F85\u624B\u673A\u4E0A\u7684\u6388\u6743\u5F39\u7A97\uFF09";
    }
  }
  try {
    const output = await adb2.shell(serial, "id", 8e3);
    if (/uid=0/.test(output)) return { mode: "adb", detail: "adbd \u5DF2\u662F root" };
  } catch {
  }
  let adbRootTried = false;
  let debuggable = false;
  try {
    debuggable = (await adb2.shell(serial, "getprop ro.debuggable", 5e3)).trim() === "1";
  } catch {
    debuggable = false;
  }
  if (adb2.root && debuggable) {
    adbRootTried = true;
    try {
      await adb2.root(serial);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const output = await adb2.shell(serial, "id", 8e3);
      if (/uid=0/.test(output)) return { mode: "adb", detail: "adb root \u6210\u529F" };
    } catch {
    }
  }
  let hasBst = false;
  try {
    hasBst = (await adb2.shell(serial, "ls /system/priv-app/com.bluestacks.BstCommandProcessor 2>/dev/null", 5e3)).trim().length > 0;
  } catch {
    hasBst = false;
  }
  if (hasBst) {
    try {
      const output = await runViaBst(adb2, serial, "id", 2e4);
      if (/uid=0/.test(output)) return { mode: "bst", detail: "BlueStacks \u670D\u52A1\u901A\u9053\uFF08su \u767D\u540D\u5355\uFF09" };
    } catch {
    }
  }
  const reason = suPath ? `${suFailure || "su \u65E0\u6CD5\u63D0\u6743"}${adbRootTried ? "\uFF1Badb root \u4E5F\u65E0\u6548" : ""}` : `\u672A\u627E\u5230 su${adbRootTried ? "\uFF0Cadb root \u4E5F\u65E0\u6548" : debuggable ? "\uFF08\u53EF\u5C1D\u8BD5 adb root\uFF09" : ""}`;
  return { mode: "none", detail: reason };
}
async function detectRoot(adb2, serial, force = false) {
  const cached = rootCache.get(serial);
  if (!force && cached && Date.now() - cached.at < ROOT_CACHE_TTL) return cached.info;
  const info = await probeRoot(adb2, serial);
  rootCache.set(serial, { at: Date.now(), info });
  return info;
}
async function deviceInfo(adb2, serial) {
  const model = (await adb2.shell(serial, "getprop ro.product.model", 1e4)).trim();
  const sdk = Number((await adb2.shell(serial, "getprop ro.build.version.sdk", 1e4)).trim()) || 0;
  let androidId = "";
  try {
    androidId = (await adb2.shell(serial, "settings get secure android_id", 1e4)).trim();
  } catch {
    androidId = "";
  }
  const packages = await adb2.shell(serial, "pm list packages -U com.tencent.mm", 15e3);
  const uidMatch = /uid:(\d+)/.exec(packages);
  const uid = uidMatch ? Number(uidMatch[1]) : null;
  let versionName = "";
  let versionCode = 0;
  if (uid !== null) {
    const dump = await adb2.shell(serial, "dumpsys package com.tencent.mm", 3e4);
    versionName = /versionName=(\S+)/.exec(dump)?.[1] ?? "";
    versionCode = Number(/versionCode=(\d+)/.exec(dump)?.[1] ?? 0);
  }
  const root = await detectRoot(adb2, serial);
  return {
    model,
    sdk,
    androidId,
    installed: uid !== null,
    uid,
    versionName,
    versionCode,
    root: root.mode !== "none",
    rootMode: root.mode,
    rootDetail: root.detail
  };
}
async function readA16(adb2, serial, root) {
  let value = "";
  try {
    value = (await runRoot(adb2, serial, root, `cat ${WECHAT_DIR}/files/recovery_v3/last_device_id 2>/dev/null`, 15e3)).trim();
  } catch {
    value = "";
  }
  if (!/^A[0-9a-f]{15}$/.test(value)) {
    try {
      value = (await runRoot(
        adb2,
        serial,
        root,
        `grep -h -a -o -m1 "A[a-f0-9]\\{15\\}" ${WECHAT_DIR}/files/kvcomm/*statistic 2>/dev/null | head -n1`,
        2e4
      )).trim();
    } catch {
      value = "";
    }
  }
  return /^A[0-9a-f]{15}$/.test(value) ? value : "";
}
async function readAccountIdentity(adb2, serial, wxid, workDir, root) {
  const safeWxid = /^[A-Za-z0-9_-]{1,64}$/.test(wxid) ? wxid : "";
  const result = {
    nickname: "",
    avatar: null,
    avatarExt: null
  };
  const remoteProfiles = `${REMOTE_DIR}/profiles.db`;
  try {
    await adb2.shell(serial, `mkdir -p ${REMOTE_DIR}`, 1e4);
    await runRoot(
      adb2,
      serial,
      root,
      `cp ${ROBOT_DB_DIR}/databases/wechat_profiles.db ${remoteProfiles} 2>/dev/null; chmod 644 ${remoteProfiles} 2>/dev/null`,
      2e4
    );
    const local = import_path.default.join(workDir, "profiles.db");
    await adb2.pull(serial, remoteProfiles, local);
    const db = await openSqlite(local);
    if (db) {
      try {
        const statement = db.prepare("SELECT nickname, avatar FROM profiles WHERE wxid = ? LIMIT 1");
        const row = statement.get(safeWxid);
        if (row && typeof row.nickname === "string") result.nickname = row.nickname;
        if (row && row.avatar instanceof Uint8Array && row.avatar.length > 8) {
          const buffer = Buffer.from(row.avatar);
          const ext = detectImage(buffer);
          if (ext) {
            result.avatar = buffer;
            result.avatarExt = ext;
          }
        }
      } finally {
        db.close();
      }
    }
  } catch {
  }
  if (!result.nickname) {
    const remoteRobot = `${REMOTE_DIR}/robot.db`;
    try {
      await runRoot(
        adb2,
        serial,
        root,
        `cp ${ROBOT_DB_DIR}/databases/robot.db ${remoteRobot} 2>/dev/null; chmod 644 ${remoteRobot} 2>/dev/null`,
        3e4
      );
      const local = import_path.default.join(workDir, "robot.db");
      await adb2.pull(serial, remoteRobot, local);
      const db = await openSqlite(local);
      if (db) {
        try {
          const statement = db.prepare(
            "SELECT name FROM entities WHERE kind = 'device' AND is_active = 1 AND ref_id = ? LIMIT 1"
          );
          const row = statement.get(safeWxid);
          if (row && typeof row.name === "string") result.nickname = row.name;
        } finally {
          db.close();
        }
      }
    } catch {
    }
  }
  if (!result.avatar) {
    const remoteAvatar = `${REMOTE_DIR}/self-avatar.png`;
    try {
      await runRoot(
        adb2,
        serial,
        root,
        `cp ${ROBOT_DB_DIR}/files/avatars/${safeWxid}.png ${remoteAvatar} 2>/dev/null; chmod 644 ${remoteAvatar} 2>/dev/null`,
        2e4
      );
      const local = import_path.default.join(workDir, `self-avatar-${Date.now()}.png`);
      await adb2.pull(serial, remoteAvatar, local);
      const buffer = await (0, import_promises2.readFile)(local);
      const ext = buffer.length > 8 ? detectImage(buffer) : null;
      if (ext) {
        result.avatar = buffer;
        result.avatarExt = ext;
      }
    } catch {
    }
  }
  await runRoot(adb2, serial, root, `rm -f ${remoteProfiles} ${REMOTE_DIR}/robot.db ${REMOTE_DIR}/self-avatar.png`, 1e4).catch(
    () => void 0
  );
  return result;
}
function fingerprint(serial, androidId) {
  return (0, import_crypto2.createHash)("sha256").update(`${serial}|${androidId}|xinghai-wechat-cloud`).digest("hex").slice(0, 16);
}
function publicProfile(metadata) {
  if (!metadata) return null;
  return {
    nickname: metadata["nickname"] ?? "",
    wxid: metadata["wxid"] ?? "",
    wechatAccount: metadata["wechat_account"] ?? "",
    wechatVersion: metadata["wechat_version"] ?? "",
    wechatVersionCode: metadata["wechat_version_code"] ?? 0,
    sourceModel: metadata["source_model"] ?? "",
    sourceFingerprint: metadata["source_fingerprint"] ?? "",
    backupId: metadata["backup_id"] ?? "",
    createdAt: metadata["created_ts"] ?? 0,
    origin: metadata["origin"] ?? "upload",
    a16Masked: maskA16(metadata["a16"]),
    hasWechatPassword: typeof metadata["wechat_password"] === "string" && metadata["wechat_password"].length > 0
  };
}
async function readSidecar(rootDir, name) {
  try {
    const raw = await (0, import_promises2.readFile)(import_path.default.join(rootDir, `${name}.json`), "utf8");
    const parsed = JSON.parse(raw);
    return parsed.metadata ?? null;
  } catch {
    return null;
  }
}
async function avatarExtOf(rootDir, name) {
  for (const ext of ["png", "jpg", "webp"]) {
    try {
      await (0, import_promises2.stat)(import_path.default.join(rootDir, `${name}.avatar.${ext}`));
      return ext;
    } catch {
    }
  }
  return null;
}
async function avatarPath(rootDir, name) {
  const ext = await avatarExtOf(rootDir, name);
  return ext ? import_path.default.join(rootDir, `${name}.avatar.${ext}`) : null;
}
async function listBackups(rootDir) {
  await (0, import_promises2.mkdir)(rootDir, { recursive: true });
  const entries = await (0, import_promises2.readdir)(rootDir, { withFileTypes: true });
  const backups = await Promise.all(
    entries.filter((entry) => entry.isFile() && import_path.default.extname(entry.name).toLowerCase() === ".xhb").map(async (entry) => {
      const info = await (0, import_promises2.stat)(import_path.default.join(rootDir, entry.name));
      const metadata = await readSidecar(rootDir, entry.name);
      return {
        name: entry.name,
        size: info.size,
        modifiedAt: info.mtimeMs,
        profile: publicProfile(metadata),
        avatar: await avatarExtOf(rootDir, entry.name)
      };
    })
  );
  backups.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return backups;
}
async function backupDetail(rootDir, name) {
  const metadata = await readSidecar(rootDir, name);
  if (!metadata) return null;
  const wxid = typeof metadata["wxid"] === "string" ? metadata["wxid"] : "";
  const wechatPassword = typeof metadata["wechat_password"] === "string" ? metadata["wechat_password"] : "";
  const a16 = typeof metadata["a16"] === "string" ? metadata["a16"] : "";
  return {
    ...publicProfile(metadata),
    wechatPassword,
    a16,
    // 标准 A16 记录：微信ID----密码----A16
    raw: a16 ? `${wxid}----${wechatPassword}----${a16}` : "",
    avatar: await avatarExtOf(rootDir, name)
  };
}
async function setWechatPassword(rootDir, name, wechatPassword) {
  const metadata = await readSidecar(rootDir, name);
  if (!metadata) return null;
  metadata["wechat_password"] = wechatPassword.slice(0, 128);
  try {
    const raw = await (0, import_promises2.readFile)(import_path.default.join(rootDir, `${name}.json`), "utf8");
    const parsed = JSON.parse(raw);
    parsed.metadata = metadata;
    await (0, import_promises2.writeFile)(import_path.default.join(rootDir, `${name}.json`), JSON.stringify(parsed, null, 2), "utf8");
  } catch {
    return null;
  }
  return backupDetail(rootDir, name);
}
async function readDeviceState(adb2, serial, rootDir, name) {
  const metadata = await readSidecar(rootDir, name);
  const recordA16 = typeof metadata?.["a16"] === "string" ? metadata["a16"] : "";
  const root = await detectRoot(adb2, serial);
  let deviceA16 = "";
  if (root.mode !== "none") {
    try {
      deviceA16 = (await runRoot(adb2, serial, root, `cat ${WECHAT_DIR}/files/recovery_v3/last_device_id 2>/dev/null`, 15e3)).trim();
    } catch {
      deviceA16 = "";
    }
  }
  const matched = Boolean(recordA16) && deviceA16 === recordA16;
  return {
    recordA16Masked: maskA16(recordA16),
    deviceA16Masked: maskA16(deviceA16),
    matched,
    detail: !deviceA16 ? "\u8BFB\u4E0D\u5230\u8BBE\u5907\u4E0A\u7684 A16\uFF08\u5FAE\u4FE1\u672A\u767B\u5F55\u6216\u5DF2\u88AB\u6E05\u7406\uFF09" : matched ? "\u767B\u5F55\u6001\u4ECD\u4E3A\u5907\u4EFD\u65F6\u7684 A16\uFF0C\u672A\u88AB\u6539\u5199" : "\u5FAE\u4FE1\u5DF2\u628A A16 \u6539\u5199\u4E3A\u65B0\u503C\uFF1A\u65B0\u8BBE\u5907\u9A8C\u8BC1\u4E2D\uFF0C\u9700\u5B8C\u6210\u4E00\u6B21\u9A8C\u8BC1"
  };
}
async function createBackup(adb2, serial, password, rootDir, wechatPassword = "") {
  if (password.length < 10) throw new Error("\u5907\u4EFD\u5BC6\u7801\u81F3\u5C1110\u4F4D");
  const info = await deviceInfo(adb2, serial);
  if (!info.installed) throw new Error("\u76EE\u6807\u673A\u672A\u5B89\u88C5\u5FAE\u4FE1");
  if (info.rootMode === "none") throw new Error(`\u76EE\u6807\u673A\u6CA1\u6709\u53EF\u7528\u7684 root\uFF1A${info.rootDetail}`);
  const root = { mode: info.rootMode, detail: info.rootDetail };
  const work = await (0, import_promises2.mkdtemp)(import_path.default.join(import_os.default.tmpdir(), "xh-wechat-backup-"));
  try {
    const archive = import_path.default.join(work, "backup.tar.gz");
    const scriptPath = import_path.default.join(work, "backup.sh");
    await (0, import_promises2.writeFile)(scriptPath, backupScript(`${REMOTE_DIR}/backup.tar.gz`), "utf8");
    await adb2.shell(serial, `mkdir -p ${REMOTE_DIR}`, 1e4);
    await adb2.push(serial, scriptPath, `${REMOTE_DIR}/backup.sh`);
    let output = "";
    try {
      output = await runRoot(adb2, serial, root, `sh ${REMOTE_DIR}/backup.sh`, BACKUP_TIMEOUT);
      if (!output.includes("BACKUP_OK")) throw new Error(`\u5907\u4EFD\u672A\u5B8C\u6210\uFF1A${tail(output, 800)}`);
      await adb2.pull(serial, `${REMOTE_DIR}/backup.tar.gz`, archive);
    } finally {
      await adb2.shell(serial, `rm -rf ${REMOTE_DIR}`, 1e4).catch(() => void 0);
      await adb2.shell(serial, "am start -n com.tencent.mm/.ui.LauncherUI", 15e3).catch(() => void 0);
    }
    await validateArchive(archive);
    const wxid = /^WXID:(.*)$/m.exec(output)?.[1]?.trim() ?? "";
    const uin = /^UIN:(.*)$/m.exec(output)?.[1]?.trim() ?? "";
    const a16 = await readA16(adb2, serial, root);
    const identity = await readAccountIdentity(adb2, serial, wxid, work, root);
    const backupId = (0, import_crypto2.randomBytes)(16).toString("hex");
    const archiveSha = await sha256File(archive);
    const metadata = {
      format: 2,
      backup_id: backupId,
      source_fingerprint: fingerprint(serial, info.androidId),
      source_model: info.model,
      android_sdk: info.sdk,
      wechat_version: info.versionName,
      wechat_version_code: info.versionCode,
      created_ts: Math.floor(Date.now() / 1e3),
      wxid,
      uin,
      nickname: identity.nickname,
      wechat_account: wxid,
      wechat_password: wechatPassword,
      a16,
      archive_sha256: archiveSha,
      origin: "cloud-backend"
    };
    const bundle = import_path.default.join(work, "bundle.bin");
    await packBundle(archive, bundle, metadata);
    await (0, import_promises2.mkdir)(rootDir, { recursive: true });
    const name = `wechat-${backupId}.xhb`;
    const target = import_path.default.join(rootDir, name);
    await encryptXhb(bundle, target, password);
    metadata["cipher_sha256"] = await sha256File(target);
    if (identity.avatar && identity.avatarExt) {
      await (0, import_promises2.writeFile)(import_path.default.join(rootDir, `${name}.avatar.${identity.avatarExt}`), identity.avatar);
      metadata["avatar"] = identity.avatarExt;
    }
    const infoSaved = await (0, import_promises2.stat)(target);
    await (0, import_promises2.writeFile)(
      import_path.default.join(rootDir, `${name}.json`),
      JSON.stringify(
        { metadata, serial, size: infoSaved.size, createdAt: (/* @__PURE__ */ new Date()).toISOString() },
        null,
        2
      ),
      "utf8"
    );
    return { name, size: infoSaved.size, metadata, profile: publicProfile(metadata) };
  } finally {
    await (0, import_promises2.rm)(work, { recursive: true, force: true }).catch(() => void 0);
  }
}
async function restoreBackup(adb2, serial, name, password, force, rootDir) {
  const local = import_path.default.join(rootDir, name);
  try {
    await (0, import_promises2.stat)(local);
  } catch {
    throw new Error("\u5907\u4EFD\u6587\u4EF6\u4E0D\u5B58\u5728\uFF0C\u8BF7\u5148\u4E0A\u4F20\u6216\u5907\u4EFD");
  }
  const info = await deviceInfo(adb2, serial);
  if (!info.installed) throw new Error("\u76EE\u6807\u673A\u672A\u5B89\u88C5\u5FAE\u4FE1");
  if (info.rootMode === "none") throw new Error(`\u76EE\u6807\u673A\u6CA1\u6709\u53EF\u7528\u7684 root\uFF1A${info.rootDetail}`);
  const root = { mode: info.rootMode, detail: info.rootDetail };
  const work = await (0, import_promises2.mkdtemp)(import_path.default.join(import_os.default.tmpdir(), "xh-wechat-restore-"));
  try {
    const bundle = import_path.default.join(work, "bundle.bin");
    const archive = import_path.default.join(work, "archive.tar.gz");
    await decryptXhb(local, bundle, password);
    const metadata = await unpackBundle(bundle, archive);
    await validateArchive(archive);
    if (metadata?.["archive_sha256"]) {
      const actual = await sha256File(archive);
      if (actual !== metadata["archive_sha256"]) throw new Error("\u5907\u4EFD\u5185\u5BB9\u6821\u9A8C\u4E0D\u4E00\u81F4\uFF0C\u53EF\u80FD\u5DF2\u635F\u574F");
    }
    if (metadata && !force) {
      const backupVersion = String(metadata["wechat_version"] ?? "");
      const backupCode = Number(metadata["wechat_version_code"] ?? 0);
      if (backupVersion && info.versionName && backupVersion !== info.versionName) {
        throw new Error(`\u5FAE\u4FE1\u7248\u672C\u4E0D\u4E00\u81F4\uFF1A\u5907\u4EFD ${backupVersion}\uFF0C\u672C\u673A ${info.versionName}`);
      }
      if (backupCode && info.versionCode && backupCode !== info.versionCode) {
        throw new Error(`\u5FAE\u4FE1\u7248\u672C\u53F7\u4E0D\u4E00\u81F4\uFF1A\u5907\u4EFD ${backupCode}\uFF0C\u672C\u673A ${info.versionCode}`);
      }
    }
    await adb2.shell(serial, `mkdir -p ${REMOTE_DIR}`, 1e4);
    await adb2.push(serial, archive, `${REMOTE_DIR}/archive.tar.gz`);
    const scriptPath = import_path.default.join(work, "restore.sh");
    await (0, import_promises2.writeFile)(scriptPath, restoreScript(info.uid, `${REMOTE_DIR}/archive.tar.gz`, `${REMOTE_DIR}/work`), "utf8");
    await adb2.push(serial, scriptPath, `${REMOTE_DIR}/restore.sh`);
    let output = "";
    try {
      output = await runRoot(adb2, serial, root, `sh ${REMOTE_DIR}/restore.sh`, RESTORE_TIMEOUT);
    } finally {
      await adb2.shell(serial, `rm -rf ${REMOTE_DIR}`, 1e4).catch(() => void 0);
    }
    return { ok: output.includes("RESTORE_OK"), output: tail(output, 6e3), profile: publicProfile(metadata) };
  } finally {
    await (0, import_promises2.rm)(work, { recursive: true, force: true }).catch(() => void 0);
  }
}
async function clearWechat(adb2, serial) {
  const root = await detectRoot(adb2, serial);
  let output = "";
  try {
    output = await runRoot(adb2, serial, root, "pm clear --user 0 com.tencent.mm", 6e4);
  } catch {
    output = await adb2.shell(serial, "pm clear --user 0 com.tencent.mm", 6e4);
  }
  return { ok: /Success/i.test(output), output: tail(output, 2e3) };
}

// src/server/wechat/standalone.ts
var MAX_UPLOAD = 512 * 1024 * 1024;
function sendJson(res, status, body) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function backupRoot() {
  return process.env["WECHAT_BACKUP_DIR"] ?? import_path2.default.join(process.cwd(), "wechat-backups");
}
function adbPath() {
  const candidates = [
    process.env["ADB_PATH"],
    process.env["DEPS_PATH"] ? import_path2.default.join(process.env["DEPS_PATH"], "adb", "adb.exe") : void 0,
    import_path2.default.join(process.cwd(), "dependencies", "adb", "adb.exe"),
    import_path2.default.join(process.cwd(), "..", "dependencies", "adb", "adb.exe")
  ];
  for (const candidate of candidates) {
    if (candidate && (0, import_fs2.existsSync)(candidate)) return candidate;
  }
  return "adb";
}
function runAdb(args, timeoutMs = 3e4) {
  return new Promise((resolve, reject) => {
    (0, import_child_process.execFile)(
      adbPath(),
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = `${stdout ?? ""}${stderr ?? ""}`.trim();
          reject(new Error(detail || error.message));
          return;
        }
        resolve(`${stdout ?? ""}${stderr ?? ""}`);
      }
    );
  });
}
var adb = {
  shell: (serial, command, timeoutMs) => runAdb(["-s", serial, "shell", command], timeoutMs).then((value) => value.trim()),
  push: (serial, local, remote) => runAdb(["-s", serial, "push", local, remote], 15 * 6e4),
  pull: (serial, remote, local) => runAdb(["-s", serial, "pull", remote, local], 15 * 6e4),
  root: (serial) => runAdb(["-s", serial, "root"], 3e4)
};
async function connectedSerials() {
  const output = await runAdb(["devices"]);
  const serials = /* @__PURE__ */ new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+device$/.exec(line.trim());
    if (match?.[1]) serials.add(match[1]);
  }
  return serials;
}
function authUser(req) {
  const port = process.env["PORT"] ?? "8001";
  return new Promise((resolve) => {
    const proxy = (0, import_http.request)(
      {
        host: "127.0.0.1",
        port,
        path: "/api/auth/me",
        method: "GET",
        headers: { cookie: req.headers.cookie ?? "" },
        timeout: 5e3
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed.user ?? null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    proxy.on("timeout", () => {
      proxy.destroy();
      resolve(null);
    });
    proxy.on("error", () => resolve(null));
    proxy.end();
  });
}
async function requireUser(req, res) {
  const user = await authUser(req);
  if (!user) sendJson(res, 401, { error: "\u672A\u767B\u5F55\u6216\u4F1A\u8BDD\u5DF2\u8FC7\u671F" });
  return user;
}
async function requireAdmin(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;
  if (user.role !== "admin") {
    sendJson(res, 403, { error: "\u9700\u8981\u7BA1\u7406\u5458\u6743\u9650" });
    return null;
  }
  return user;
}
function saveUpload(req, target) {
  return new Promise((resolve, reject) => {
    const out = (0, import_fs2.createWriteStream)(target);
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      out.destroy();
      reject(error);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD) {
        fail(new Error("upload too large"));
        req.destroy();
      }
    });
    req.pipe(out);
    out.on("finish", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    out.on("error", fail);
    req.on("error", fail);
  });
}
function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    let size = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        req.destroy();
        resolve({});
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}
var busy = /* @__PURE__ */ new Set();
function serialOf(value) {
  const serial = typeof value === "string" ? value : "";
  return /^[A-Za-z0-9._:-]{1,128}$/.test(serial) ? serial : "";
}
function backupNameOf(value) {
  const name = import_path2.default.basename(typeof value === "string" ? value : "");
  return /^[\w.\-()（） ]{1,180}\.xhb$/i.test(name) ? name : "";
}
function handleWechatRequest(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/wechat/")) return false;
  void (async () => {
    try {
      if (req.method === "GET" && pathname === "/api/wechat/backups") {
        if (!await requireUser(req, res)) return;
        sendJson(res, 200, { backups: await listBackups(backupRoot()) });
        return;
      }
      if (req.method === "POST" && pathname === "/api/wechat/backups") {
        if (!await requireAdmin(req, res)) return;
        const name = backupNameOf(url.searchParams.get("name"));
        if (!name) {
          sendJson(res, 400, { error: "\u6587\u4EF6\u540D\u65E0\u6548" });
          return;
        }
        const root = backupRoot();
        await (0, import_promises3.mkdir)(root, { recursive: true });
        const target = import_path2.default.join(root, name);
        try {
          await saveUpload(req, target);
        } catch (error) {
          await (0, import_promises3.rm)(target, { force: true }).catch(() => void 0);
          sendJson(res, errorMessage(error) === "upload too large" ? 413 : 500, {
            error: errorMessage(error) === "upload too large" ? "\u5907\u4EFD\u4E0D\u80FD\u8D85\u8FC7 512 MB" : errorMessage(error)
          });
          return;
        }
        sendJson(res, 201, { ok: true, name });
        return;
      }
      if (req.method === "DELETE" && pathname === "/api/wechat/backups") {
        if (!await requireAdmin(req, res)) return;
        const name = backupNameOf(url.searchParams.get("name"));
        if (!name) {
          sendJson(res, 400, { error: "\u6587\u4EF6\u540D\u65E0\u6548" });
          return;
        }
        await (0, import_promises3.rm)(import_path2.default.join(backupRoot(), name), { force: true });
        await (0, import_promises3.rm)(import_path2.default.join(backupRoot(), `${name}.json`), { force: true });
        for (const ext of ["png", "jpg", "webp"]) {
          await (0, import_promises3.rm)(import_path2.default.join(backupRoot(), `${name}.avatar.${ext}`), { force: true });
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && pathname === "/api/wechat/device") {
        if (!await requireUser(req, res)) return;
        const serial = serialOf(url.searchParams.get("serial"));
        if (!serial) {
          sendJson(res, 400, { error: "\u8BBE\u5907\u5E8F\u5217\u53F7\u65E0\u6548" });
          return;
        }
        sendJson(res, 200, await deviceInfo(adb, serial));
        return;
      }
      if (req.method === "POST" && pathname === "/api/wechat/backup") {
        if (!await requireAdmin(req, res)) return;
        const body = await readJson(req);
        const serial = serialOf(body["serial"]);
        const password = typeof body["password"] === "string" ? body["password"] : "";
        const wechatPassword = typeof body["wechatPassword"] === "string" ? body["wechatPassword"].slice(0, 128) : "";
        if (!serial) {
          sendJson(res, 400, { error: "\u8BBE\u5907\u5E8F\u5217\u53F7\u65E0\u6548" });
          return;
        }
        if (password.length < 10) {
          sendJson(res, 400, { error: "\u5907\u4EFD\u5BC6\u7801\u81F3\u5C1110\u4F4D" });
          return;
        }
        if (busy.has(serial)) {
          sendJson(res, 409, { error: "\u8BE5\u8BBE\u5907\u6B63\u5728\u6267\u884C\u5176\u5B83\u5907\u4EFD\u64CD\u4F5C" });
          return;
        }
        if (!(await connectedSerials()).has(serial)) {
          sendJson(res, 409, { error: "\u624B\u673A\u672A\u8FDE\u63A5" });
          return;
        }
        busy.add(serial);
        try {
          const result = await createBackup(adb, serial, password, backupRoot(), wechatPassword);
          sendJson(res, 200, { ok: true, name: result.name, size: result.size, profile: result.profile });
        } catch (error) {
          sendJson(res, 500, { error: errorMessage(error) });
        } finally {
          busy.delete(serial);
        }
        return;
      }
      if (req.method === "POST" && pathname === "/api/wechat/restore") {
        if (!await requireAdmin(req, res)) return;
        const body = await readJson(req);
        const serial = serialOf(body["serial"]);
        const name = backupNameOf(body["name"]);
        const password = typeof body["password"] === "string" ? body["password"] : "";
        const force = body["force"] === true;
        if (!serial || !name) {
          sendJson(res, 400, { error: "\u8BBE\u5907\u6216\u5907\u4EFD\u53C2\u6570\u65E0\u6548" });
          return;
        }
        if (password.length < 10) {
          sendJson(res, 400, { error: "\u5907\u4EFD\u5BC6\u7801\u81F3\u5C1110\u4F4D" });
          return;
        }
        if (busy.has(serial)) {
          sendJson(res, 409, { error: "\u8BE5\u8BBE\u5907\u6B63\u5728\u6267\u884C\u5176\u5B83\u5907\u4EFD\u64CD\u4F5C" });
          return;
        }
        if (!(await connectedSerials()).has(serial)) {
          sendJson(res, 409, { error: "\u624B\u673A\u672A\u8FDE\u63A5" });
          return;
        }
        busy.add(serial);
        try {
          const result = await restoreBackup(adb, serial, name, password, force, backupRoot());
          sendJson(res, result.ok ? 200 : 500, result);
        } catch (error) {
          sendJson(res, 500, { error: errorMessage(error) });
        } finally {
          busy.delete(serial);
        }
        return;
      }
      if (req.method === "POST" && pathname === "/api/wechat/clear") {
        if (!await requireAdmin(req, res)) return;
        const body = await readJson(req);
        const serial = serialOf(body["serial"]);
        if (!serial) {
          sendJson(res, 400, { error: "\u8BBE\u5907\u5E8F\u5217\u53F7\u65E0\u6548" });
          return;
        }
        if (busy.has(serial)) {
          sendJson(res, 409, { error: "\u8BE5\u8BBE\u5907\u6B63\u5728\u6267\u884C\u5176\u5B83\u5907\u4EFD\u64CD\u4F5C" });
          return;
        }
        const result = await clearWechat(adb, serial);
        sendJson(res, result.ok ? 200 : 500, result);
        return;
      }
      if (req.method === "GET" && pathname === "/api/wechat/avatar") {
        if (!await requireUser(req, res)) return;
        const name = backupNameOf(url.searchParams.get("name"));
        if (!name) {
          sendJson(res, 400, { error: "\u6587\u4EF6\u540D\u65E0\u6548" });
          return;
        }
        const file = await avatarPath(backupRoot(), name);
        if (!file) {
          sendJson(res, 404, { error: "\u6CA1\u6709\u5934\u50CF" });
          return;
        }
        const ext = import_path2.default.extname(file).slice(1).toLowerCase();
        const type = ext === "png" ? "image/png" : ext === "jpg" ? "image/jpeg" : "image/webp";
        res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
        (0, import_fs2.createReadStream)(file).pipe(res);
        return;
      }
      if (req.method === "GET" && pathname === "/api/wechat/detail") {
        if (!await requireAdmin(req, res)) return;
        const name = backupNameOf(url.searchParams.get("name"));
        if (!name) {
          sendJson(res, 400, { error: "\u6587\u4EF6\u540D\u65E0\u6548" });
          return;
        }
        const detail = await backupDetail(backupRoot(), name);
        if (!detail) {
          sendJson(res, 404, { error: "\u8BE5\u5907\u4EFD\u6CA1\u6709\u8D26\u53F7\u8D44\u6599\uFF08\u53EF\u80FD\u662F\u4E0A\u4F20\u7684\u65E7\u5907\u4EFD\uFF09" });
          return;
        }
        sendJson(res, 200, detail);
        return;
      }
      if (req.method === "POST" && pathname === "/api/wechat/password") {
        if (!await requireAdmin(req, res)) return;
        const body = await readJson(req);
        const name = backupNameOf(body["name"]);
        const wechatPassword = typeof body["wechatPassword"] === "string" ? body["wechatPassword"].slice(0, 128) : "";
        if (!name || !wechatPassword) {
          sendJson(res, 400, { error: "\u53C2\u6570\u65E0\u6548" });
          return;
        }
        const detail = await setWechatPassword(backupRoot(), name, wechatPassword);
        if (!detail) {
          sendJson(res, 404, { error: "\u8BE5\u5907\u4EFD\u6CA1\u6709\u8D26\u53F7\u8D44\u6599" });
          return;
        }
        sendJson(res, 200, detail);
        return;
      }
      if (req.method === "GET" && pathname === "/api/wechat/state") {
        if (!await requireUser(req, res)) return;
        const serial = serialOf(url.searchParams.get("serial"));
        const name = backupNameOf(url.searchParams.get("name"));
        if (!serial || !name) {
          sendJson(res, 400, { error: "\u53C2\u6570\u65E0\u6548" });
          return;
        }
        sendJson(res, 200, await readDeviceState(adb, serial, backupRoot(), name));
        return;
      }
      sendJson(res, 405, { error: "method not allowed" });
    } catch (error) {
      sendJson(res, 500, { error: errorMessage(error) });
    }
  })();
  return true;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handleWechatRequest
});
