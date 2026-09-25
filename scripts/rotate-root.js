/**
 * 根证书信任集管理脚本
 *
 * nos/root-cert.json 采用信任集格式（generation 单调递增）：
 * {
 *   "type": "root",
 *   "name": "noneos-root",
 *   "generation": 1,
 *   "signTime": 1748261520193,
 *   "publicKey": "<签名者公钥，必须属于 keys 中 active/grace 项>",
 *   "keys": [{ "id": "root", "publicKey": "...", "status": "active" }],
 *   "signature": "<由 publicKey 对应私钥签发>"
 * }
 *
 * 密钥文件存放约定：
 * - 根密钥（内置 pin 的信任锚）：rootkeys/root.json，id 固定为 "root"
 * - 轮换新增密钥：rootkeys/keys/<id>.json
 *
 * 常规轮换流程：
 *   node scripts/rotate-root.js init            # 初始化 generation 1 信任集（单 active 根密钥）
 *   node scripts/rotate-root.js add k2          # 生成新密钥，以 grace 状态加入信任集（旧钥签名）
 *   node scripts/sign-hashes.js                 # （可选）此阶段仍由旧钥签发 nos.json
 *   node scripts/rotate-root.js promote k2      # 新钥转 active、旧钥转 retired，改由新钥签名
 *   node scripts/sign-hashes.js                 # 用新 active 密钥重签 nos.json
 *
 * 泄漏应急轮换：跳过 grace 阶段，直接用备用密钥执行 promote（须提前把备用密钥指纹
 * 加入 nos-tool/_install/util.js 的 PINNED_ROOT_KEY_HASHES 并发布新版客户端）。
 *
 * 查询内置 pin 所需指纹：node scripts/rotate-root.js pin-hash [id]
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);

import { createSigner, generateKeyPair } from "../nos/crypto/crypto-ecdsa.js";
import { getHash } from "../nos/util/hash/get-hash.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const rootCertPath = join(repoRoot, "nos/root-cert.json");
const keysDir = join(repoRoot, "rootkeys/keys");

const CERT_NAME = "noneos-root";
const ROOT_KEY_ID = "root";

const toBase64 = (buffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)));

const loadRootPair = () => JSON.parse(readFileSync(join(repoRoot, "rootkeys/root.json"), "utf8"));

// 按 id 查找密钥文件：rootkeys/keys/<id>.json → rootkeys/<id>.json → rootkeys/root.json（id 为 "root"）
const findKeyFile = (id) => {
  const candidates = [
    join(keysDir, `${id}.json`),
    join(repoRoot, `rootkeys/${id}.json`),
    ...(id === ROOT_KEY_ID ? [join(repoRoot, "rootkeys/root.json")] : []),
  ];
  return candidates.find((path) => existsSync(path));
};

const loadKeyPair = (id) => {
  const path = findKeyFile(id);
  if (!path) {
    throw new Error(`Key file not found for id "${id}"`);
  }
  return { path, pair: JSON.parse(readFileSync(path, "utf8")) };
};

const loadCert = () => JSON.parse(readFileSync(rootCertPath, "utf8"));

const signCert = async (certData, privateKeyBase64) => {
  const sign = await createSigner(privateKeyBase64);
  return toBase64(await sign(JSON.stringify(certData)));
};

// 签名者必须是信任集中 active/grace 的密钥（retired 密钥不可再签发新信任集）
const pickSigner = (cert) => {
  for (const status of ["active", "grace"]) {
    const entry = cert.keys.find((key) => key.status === status && findKeyFile(key.id));
    if (entry) {
      return entry;
    }
  }
  throw new Error("No active/grace key with a resolvable key file found in trust set");
};

const saveCert = async (certData, signerId) => {
  const { pair } = loadKeyPair(signerId);
  if (pair.public !== certData.publicKey) {
    throw new Error(`Signer key "${signerId}" does not match cert publicKey`);
  }
  const signature = await signCert(certData, pair.private);
  writeFileSync(rootCertPath, JSON.stringify({ ...certData, signature }, null, 2) + "\n");
  console.log(`root-cert.json written (generation ${certData.generation}, signer "${signerId}")`);
};

const assertCertExists = (cert) => {
  if (!Array.isArray(cert.keys)) {
    throw new Error("nos/root-cert.json is not in trust-set format; run `init` first");
  }
};

const commands = {
  // 初始化 generation 1 信任集：仅含根密钥（active）
  async init() {
    const pair = loadRootPair();
    const certData = {
      type: "root",
      name: CERT_NAME,
      generation: 1,
      signTime: Date.now(),
      publicKey: pair.public,
      keys: [{ id: ROOT_KEY_ID, publicKey: pair.public, status: "active" }],
    };
    await saveCert(certData, ROOT_KEY_ID);
  },

  // 生成新密钥并以 grace 状态加入信任集（仍由旧钥签名，客户端平滑过渡）
  async add(newId) {
    if (!newId) {
      throw new Error("Usage: rotate-root.js add <id>");
    }
    const cert = loadCert();
    assertCertExists(cert);
    if (findKeyFile(newId)) {
      throw new Error(`Key file for id "${newId}" already exists`);
    }
    if (cert.keys.some((key) => key.id === newId)) {
      throw new Error(`Key id "${newId}" already exists in trust set`);
    }
    const pair = await generateKeyPair();
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(
      join(keysDir, `${newId}.json`),
      JSON.stringify({ public: pair.publicKey, private: pair.privateKey }, null, 2) + "\n",
    );
    const certData = {
      ...cert,
      generation: cert.generation + 1,
      signTime: Date.now(),
      keys: [...cert.keys, { id: newId, publicKey: pair.publicKey, status: "grace" }],
    };
    const signer = pickSigner(cert);
    await saveCert(certData, signer.id);
    console.log(`Next step: run \`promote ${newId}\` to switch nos.json signing to the new key.`);
  },

  // 指定密钥转 active，其余 active 密钥转 retired，改由指定密钥签名
  async promote(id) {
    const cert = loadCert();
    assertCertExists(cert);
    const entry = cert.keys.find((key) => key.id === id);
    if (!entry) {
      throw new Error(`Key id "${id}" not found in trust set`);
    }
    if (entry.status === "active") {
      throw new Error(`Key "${id}" is already active`);
    }
    const certData = {
      ...cert,
      generation: cert.generation + 1,
      signTime: Date.now(),
      publicKey: entry.publicKey,
      keys: cert.keys.map((key) => ({
        ...key,
        status: key.id === id ? "active" : key.status === "active" ? "retired" : key.status,
      })),
    };
    await saveCert(certData, id);
    console.log("Next step: run `node scripts/sign-hashes.js` to re-sign nos.json with the new key.");
  },

  // 将指定密钥移出信任集（应急轮换时移除泄漏密钥）
  async retire(id) {
    const cert = loadCert();
    assertCertExists(cert);
    const entry = cert.keys.find((key) => key.id === id);
    if (!entry || entry.status === "retired") {
      throw new Error(`Key id "${id}" not found or already retired`);
    }
    const certData = {
      ...cert,
      generation: cert.generation + 1,
      signTime: Date.now(),
      keys: cert.keys.map((key) =>
        key.id === id ? { ...key, status: "retired" } : key,
      ),
    };
    const signer = pickSigner(certData);
    await saveCert(certData, signer.id);
  },

  // 输出密钥公钥指纹（sha-256 hex），用于写入客户端 PINNED_ROOT_KEY_HASHES
  async "pin-hash"(id) {
    const { pair } = loadKeyPair(id || ROOT_KEY_ID);
    console.log(await getHash(pair.public));
  },
};

const [command, ...args] = process.argv.slice(2);

if (!commands[command]) {
  console.error(
    `Usage: node scripts/rotate-root.js <init|add|promote|retire|pin-hash> [id]\n` +
      `Commands: ${Object.keys(commands).join(", ")}`,
  );
  process.exit(1);
}

await commands[command](...args);
