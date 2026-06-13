export class ServerManager {
  #wsMap = new Map();
  #user;

  constructor(user) {
    this.#user = user;
  }
}
