import { verifyData } from "../nos/crypto/crypto-verify.js";

export const getOnlineData = async () => {
  const rootCert = await fetch(
    import.meta.resolve("../nos/root-cert.json"),
  ).then((e) => e.json());

  const isRootCertValid = await verifyData(rootCert);

  if (!isRootCertValid) {
    throw new Error("Root certificate verification failed");
  }

  const onlineNosConfig = await fetch(import.meta.resolve("../nos.json")).then(
    (res) => res.json(),
  );

  const isNosConfigValid = await verifyData(onlineNosConfig);

  if (!isNosConfigValid) {
    throw new Error("nos.json verification failed");
  }

  return {
    rootCert,
    onlineNosConfig,
  };
};

// 注册 Service Worker
export const registerSw = async (name) => {
  if (!navigator.serviceWorker) {
    throw new Error("Service Worker is not supported");
  }

  const registration = await navigator.serviceWorker.register("/" + name);

  await navigator.serviceWorker.ready;

  if (registration.active?.state === "activated") {
    return registration;
  }

  const activeWorker = registration.active || registration.installing;

  return new Promise((resolve, reject) => {
    if (!activeWorker) {
      reject(new Error("No active Service Worker found"));
      return;
    }

    const handleStateChange = () => {
      if (activeWorker.state === "activated") {
        console.log("Service Worker activated:", registration.scope);
        resolve(registration);
      }
    };

    activeWorker.addEventListener("statechange", handleStateChange);

    if (activeWorker.state === "activated") {
      handleStateChange();
    }
  });
};

export const clearSw = async () => {
  const registrations = await navigator.serviceWorker.getRegistrations();

  await Promise.all(
    registrations.map(async (registration) => {
      const success = await registration.unregister();
      if (success) {
        console.log("Service Worker unregistered:", registration.scope);
      }
    }),
  );
};
