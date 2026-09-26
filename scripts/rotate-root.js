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
 * - 根密钥（pin 信任锚之一）：rootkeys/root.json，id 固定为 "root"
 * - 轮换新增密钥：rootkeys/keys/<id>.json
 *
 * 常规轮换流程：
 *   node scripts/rotate-root.js init            # 初始化 generation 1 信任集（单 active 根密钥）
 *   node scripts/rotate-root.js add k2          # 生成新密钥，以 grace 状态加入信任集（旧钥签名）
 *   node scripts/rotate-root.js promote k2      # 新钥转 active、旧钥 retired，改由新钥签名
 *
 * 手动换根密钥：新密钥对放入 rootkeys/root.json，旧密钥对保留为 rootkeys/root-legacy.json，
 * 然后执行
 *   node scripts/rotate-root.js swap-root
 * 脚本会校验公私钥配对、由旧钥签发新信任集（新钥转 active、旧钥转 grace）、
 * 自动重写客户端 PINNED_ROOT_KEY_HASHES、重算哈希并重签 nos.json。
 * 过渡完成后可执行 `retire root-legacy` 彻底退役旧钥（pin 随之移除旧指纹）。
 *
 * 其他命令：
 *   node scripts/rotate-root.js check           # 校验 rootkeys/root.json 公私钥是否配对
 *   node scripts/rotate-root.js revoke <id|指纹>  # 吊销密钥（泄漏保底机制，见根目录 root-status.json）
 *   node scripts/rotate-root.js pin-hash [id]   # 输出内置 pin 所需指纹
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);

import { createSigner, generateKeyPair, createVerifier } from "../nos/crypto/crypto-ecdsa.js";
import { getHash } from "../nos/util/hash/get-hash.js";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const rootCertPath = join(repoRoot, "nos/root-cert.json");
const rootStatusPath = join(repoRoot, "root-status.json");
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

// swap-root 用：旧根私钥的保留位置（手动换根前，把旧 rootkeys/root.json 移到这里）
const LEGACY_KEY_CANDIDATES = [
  join(repoRoot, "rootkeys/root-legacy.json"),
  join(keysDir, "root-legacy.json"),
];

const loadLegacyRootPair = () => {
  const path = LEGACY_KEY_CANDIDATES.find((p) => existsSync(p));
  if (!path) {
    throw new Error(
      "Old root private key not found. Before replacing rootkeys/root.json, keep a copy at rootkeys/root-legacy.json\n" +
        "(the new trust set must still be signed by the old key so cached clients can chain-trust it)."
    );
  }
  console.log(`Legacy root key loaded from ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
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

const saveCert = async (certData, signerId, signerPair) => {
  const pair = signerPair || loadKeyPair(signerId).pair;
  if (pair.public !== certData.publicKey) {
    throw new Error(`Signer key "${signerId}" does not match cert publicKey`);
  }
  // 签名对象必须不含 signature 字段（与客户端 verifyData 的验签口径一致）
  const { signature: _prevSignature, ...certBody } = certData;
  const signature = await signCert(certBody, pair.private);
  writeFileSync(rootCertPath, JSON.stringify({ ...certBody, signature }, null, 2) + "\n");
  console.log(`root-cert.json written (generation ${certBody.generation}, signer "${signerId}")`);
};

const clientUtilPath = join(repoRoot, "nos-tool/_install/util.js");

// 将客户端内置 pin 重写为信任集中所有未退役密钥的指纹（单一事实来源）
const updatePinnedHashes = async (cert) => {
  const entries = [];
  for (const key of cert.keys) {
    if (key.status === "retired") {
      continue;
    }
    entries.push(`  // ${key.id} (${key.status})\n  "${await getHash(key.publicKey)}",`);
  }
  const content = readFileSync(clientUtilPath, "utf8");
  const pinBlock = `const PINNED_ROOT_KEY_HASHES = new Set([\n${entries.join("\n")}\n]);`;
  const updated = content.replace(
    /const PINNED_ROOT_KEY_HASHES = new Set\(\[[\s\S]*?\]\);/,
    pinBlock,
  );
  if (updated === content) {
    throw new Error("PINNED_ROOT_KEY_HASHES block not found in nos-tool/_install/util.js");
  }
  writeFileSync(clientUtilPath, updated);
  console.log(`PINNED_ROOT_KEY_HASHES updated (${cert.keys.filter((k) => k.status !== "retired").length} key(s))`);
};

// 信任集变更后，hashes 随之变化：重算 hashes 并由 active 密钥重签 nos.json
const rebuildManifest = () => {
  execSync("node scripts/calculate-nos-hashes.js", { cwd: repoRoot, stdio: "inherit" });
  execSync("node scripts/sign-hashes.js", { cwd: repoRoot, stdio: "inherit" });
  console.log("hashes.json recalculated and nos.json re-signed");
};

const assertCertExists = (cert) => {
  if (!Array.isArray(cert.keys)) {
    throw new Error("nos/root-cert.json is not in trust-set format; run `init` first");
  }
};

const commands = {
  // 校验 rootkeys/root.json 公私钥是否配对，并输出公钥指纹
  async check() {
    const pair = loadRootPair();
    const message = "root-key-pair-check";
    const sign = await createSigner(pair.private);
    const verify = await createVerifier(pair.public);
    const signature = await sign(message);
    const valid = await verify(message, signature);
    if (!valid) {
      throw new Error("rootkeys/root.json public/private key mismatch");
    }
    console.log("rootkeys/root.json pair is valid.");
    console.log(`public key sha-256: ${await getHash(pair.public)}`);
  },

  // 手动换根：新密钥对放 rootkeys/root.json，旧密钥对保留在 rootkeys/root-legacy.json，然后执行。
  // 新钥转 active（后续 nos.json 由它签发），旧钥转 grace 并由旧钥签名新信任集：
  // 已装机客户端通过缓存链式信任自动接受，全新安装客户端通过 pin（自动含新旧指纹）接受。
  async "swap-root"() {
    const newPair = loadRootPair();
    const cert = loadCert();
    assertCertExists(cert);

    // 校验新公私钥配对
    const swapMessage = "root-key-pair-check";
    const swapSign = await createSigner(newPair.private);
    const swapVerify = await createVerifier(newPair.public);
    if (!(await swapVerify(swapMessage, await swapSign(swapMessage)))) {
      throw new Error("rootkeys/root.json public/private key mismatch");
    }

    const oldSigner = pickSigner(cert);
    if (oldSigner.publicKey === newPair.public) {
      throw new Error("rootkeys/root.json is unchanged; nothing to swap");
    }

    const legacyPair = loadLegacyRootPair();
    if (legacyPair.public !== oldSigner.publicKey) {
      throw new Error(
        "rootkeys/root-legacy.json does not match the current cert signer; restore the correct old root key"
      );
    }

    const certData = {
      ...cert,
      generation: cert.generation + 1,
      signTime: Date.now(),
      // 签名者保持旧钥（已装机客户端的缓存信任集里只有旧钥），但 nos.json 改由新钥签发
      publicKey: oldSigner.publicKey,
      keys: [
        ...cert.keys.map((key) =>
          key.id === oldSigner.id
            ? { ...key, id: `${key.id}-legacy`, status: "grace" }
            : key,
        ),
        { id: ROOT_KEY_ID, publicKey: newPair.public, status: "active" },
      ],
    };

    await saveCert(certData, oldSigner.id, legacyPair);
    await updatePinnedHashes(certData);
    rebuildManifest();
    console.log(
      "Root key swapped. Deploy the updated nos/ and nos-tool/_install/util.js.\n" +
        'After the transition window, run `node scripts/rotate-root.js retire root-legacy` to fully retire the old key.',
    );
  },

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
    await updatePinnedHashes(certData);
    rebuildManifest();
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
    await updatePinnedHashes(certData);
    rebuildManifest();
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
    await updatePinnedHashes(certData);
    rebuildManifest();
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
    // publicKey 字段必须与实际签名者一致
    certData.publicKey = signer.publicKey;
    await saveCert(certData, signer.id);
    await updatePinnedHashes(certData);
    rebuildManifest();
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
