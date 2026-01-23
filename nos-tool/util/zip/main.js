const workerPath = import.meta.resolve("./worker.js");

const createWorker = async () => {
  try {
    return new Worker(workerPath);
  } catch {
    const blob = await fetch(workerPath).then((r) => r.blob());
    return new Worker(URL.createObjectURL(blob));
  }
};

const resolvers = new Map();

const worker = await createWorker();

const generateId =
  typeof crypto !== "undefined" && crypto.randomUUID
    ? () => crypto.randomUUID()
    : () => Math.random().toString(16).slice(2, 18);

worker.onmessage = (e) => {
  const { id, error, content } = e.data;
  const task = resolvers.get(id);
  if (task) {
    error ? task.reject(error) : task.resolve(content);
    resolvers.delete(id);
  }
};

export async function unzip(file) {
  const id = generateId();
  const promise = new Promise((resolve, reject) =>
    resolvers.set(id, { resolve, reject }),
  );
  worker.postMessage({ taskType: "unzip", id, file });
  return promise;
}

export function zips(files) {
  if (!files.length) return null;

  const id = generateId();
  const { resolve, promise } = Promise.withResolvers();
  resolvers.set(id, { resolve, reject: () => {} });

  const lastIndex = files.length - 1;
  files.forEach(({ file, path }, index) => {
    worker.postMessage({ id, path, file, isEnd: index === lastIndex });
  });

  return promise;
}
