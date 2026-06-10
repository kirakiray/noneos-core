import { LocalUser } from "./local/user.js";

const users = new Map();

export const getUser = async (namespace) => {
  let user = null;
  if (users.has(namespace)) {
    user = users.get(namespace);
  } else {
    user = new LocalUser(namespace);
    users.set(namespace, user);
  }

  await user.ready();

  return user;
};
