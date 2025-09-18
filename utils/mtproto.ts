// utils/mtproto.ts
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import readline from "readline";
import fs from "fs";
import path from "path";
import { config } from "../config";

// Путь к файлу сессии
const SESSION_FILE = process.env.TG_SESSION_FILE || path.resolve(process.cwd(), ".telegram.session");

function readSessionFromFile(): string {
  try {
    if (!fs.existsSync(SESSION_FILE)) return "";
    const data = fs.readFileSync(SESSION_FILE, "utf8").trim();
    console.log(`Прочитана сессия: ${data.length} символов`);
    return data;
  } catch (e) {
    console.error("Ошибка чтения файла сессии:", e);
    return "";
  }
}

function writeSessionToFile(session: string) {
  try {
    if (!session) {
      console.warn("Пустая сессия, ничего не сохраняем");
      return;
    }
    const dir = path.dirname(SESSION_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SESSION_FILE, session, "utf8");
    console.log(`Сессия сохранена: ${SESSION_FILE} (${session.length} символов)`);
  } catch (e) {
    console.error("Не удалось сохранить сессию:", e);
  }
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (ans) => { rl.close(); res(ans.trim()); }));
}

export class TGClient {
  private stringSession: StringSession;
  private client: TelegramClient;
  private isConnected = false;
  private entityCache = new Map<string, any>();

  constructor() {
    const initial = readSessionFromFile();
    this.stringSession = new StringSession(initial);
    this.client = new TelegramClient(
      this.stringSession,
      Number(config.telegram_api_id),
      String(config.telegram_api_hash),
      { deviceModel: "bun-ts", appVersion: "1.0.0", systemVersion: "linux", connectionRetries: 5 }
    );
  }

  async connect() {
    if (this.isConnected) return;
    try {
      await this.client.connect();
      const me = await this.client.getMe();
      console.log("Подключились как:", (me as any)?.username ?? (me as any)?.id);

      // Сохраняем строковую сессию
      const sessionString: string = this.stringSession.save();
      writeSessionToFile(sessionString);

      this.isConnected = true;
      return me;
    } catch {
      console.log("Нужна авторизация");
      await this.startAuth();
      this.isConnected = true;
    }
  }

  private async startAuth() {
    await this.client.start({
      phoneNumber: async () => await ask("Телефон (+7...): "),
      password: async () => await ask("2FA пароль (если есть): "),
      phoneCode: async () => await ask("Код из Telegram: "),
      onError: (e) => console.error("Auth error:", e),
    });
    console.log("Авторизация завершена");

    // Сохраняем строковую сессию
    const sessionString: string = this.stringSession.save();
    writeSessionToFile(sessionString);
  }

  private async warmUp() {
    const key = "dialogs";
    if (this.entityCache.has(key)) return;
    try {
      console.log("Прогрев диалогов...");
      const dialogs = await this.client.getDialogs({ limit: 10 });
      console.log(`Прогрето диалогов: ${dialogs.length}`);
    } catch (e) {
      console.warn("Не удалось прогреть диалоги:", e);
    }
    this.entityCache.set(key, true);
  }

  private async resolvePeer(chat: string | number): Promise<Api.TypeInputPeer> {
    const key = `peer_${chat}`;
    if (this.entityCache.has(key)) return this.entityCache.get(key);

    if (typeof chat === "string") {
      const ent = await this.client.getInputEntity(chat);
      this.entityCache.set(key, ent);
      return ent;
    }

    await this.warmUp();
    const id = Number(chat);
    if (id.toString().startsWith("-100")) {
      const abs = Math.abs(id);
      try {
        const ent = (await this.client.getInputEntity(abs)) as Api.InputPeerChannel;
        this.entityCache.set(key, ent);
        return ent;
      } catch {
        throw new Error("Нужен @username канала");
      }
    }
    if (id < 0) {
      const ent = (await this.client.getInputEntity(-id)) as Api.InputPeerChat;
      this.entityCache.set(key, ent);
      return ent;
    }
    const ent = (await this.client.getInputEntity(id)) as Api.InputPeerUser;
    this.entityCache.set(key, ent);
    return ent;
  }

  // 2. Логи в loadHistoryUsers
  private async loadHistoryUsers(
    peer: Api.TypeInputPeer,
    limit = 100
  ): Promise<Map<string, Api.User>> {
    console.log(`Загружаем историю (limit=${limit}) для peer:`, peer);
    const result = await this.client.invoke(
      new Api.messages.GetHistory({
        peer,
        offsetId: 0,
        offsetDate: 0,
        addOffset: 0,
        limit: Math.min(limit, 100),
        maxId: 0,
        minId: 0,
        hash: 0n as any,
      })
    );
    const users = ((result as any).users as Api.User[]) || [];
    console.log(`  Получено ${users.length} пользователей из истории`);

    const map = new Map<string, Api.User>();
    for (const u of users) {
      console.log(`    История User: id=${u.id} accessHash=${(u as any).accessHash}`);
      map.set(String(u.id), u);
    }
    return map;
  }

  // 1. Логи в warmUpUsersInChannel
  private async warmUpUsersInChannel(
    channelPeer: Api.InputPeerChannel,
    userIds: number[]
  ): Promise<void> {
    console.log("Начинаем прогрев пользователей:", userIds);
    for (const uid of userIds) {
      try {
        console.log(`  Прогрев пользователя ${uid} через GetParticipant...`);
        const res = await this.client.invoke(
          new Api.channels.GetParticipant({
            channel: channelPeer,
            participant: new Api.InputUser({
              userId: BigInt(uid) as any,
              accessHash: 0n as any
            })
          })
        );
        console.log("    Результат GetParticipant:", res);
        console.log("Содержимое !!!!");
        console.log("Содержимое stringSession:", this.stringSession.save());
      } catch (e) {
        console.warn(`    Прогрев для ${uid} не сработал:`, e);
      }
    }
  }

  //   // 3. Логи перед GetSearchCounters
  // async getSearchCounters(
  //   chat: string | number,
  //   userIds: Array<number>,
  //   dayAgoSec: number,
  //   nowSec: number
  // ): Promise<Record<string, number>> {
  //   await this.connect();
  //   const peer = await this.resolvePeer(chat) as Api.InputPeerChannel;
  //   console.log("Peer для GetSearchCounters:", peer);

  //   // Прогрев
  //   await this.warmUpUsersInChannel(peer, userIds);

  //   // Составляем фильтры
  //   const filters = userIds.map(uid => {
  //     console.log(`  Создаём фильтр для userId=${uid}`);
  //     return new Api.InputMessagesFilterUser({ userId: BigInt(uid) as any });
  //   });

  //   console.log("Вызываем GetSearchCounters с фильтрами:", filters);
  //   const res = await this.client.invoke(
  //     new Api.messages.GetSearchCounters({
  //       peer: peer as Api.InputChannel,
  //       filters,
  //       minDate: dayAgoSec,
  //       maxDate: nowSec,
  //       offset: 0,
  //       limit: filters.length,
  //       hash: 0n as any
  //     })
  //   ) as Api.messages.MessageCounts;

  //   console.log("GetSearchCounters вернул:", res);
  //   const result: Record<string, number> = {};
  //   for (const entry of res.counts) {
  //     const uid = String((entry.filter as any).userId);
  //     console.log(`  Пользователь ${uid}: count=${entry.count}`);
  //     result[uid] = entry.count;
  //   }
  //   return result;
  // }

  public debugSession() {
    // @ts-ignore
    const raw = (this.stringSession as any).session;  
    console.log("=== Debug StringSession internal state ===");
    console.log("DC:", raw.dcId);
    console.log("Auth key fingerprint:", raw.authKey?.id?.toString());
    // Список сохранённых peers (включая пользователей) — объект с access_hash
    console.log("Saved peers (access_hash map):", raw.peers);
    console.log("Saved users:", raw.users);
    console.log("=========================================");
  }

  public async debugUserAccessHash(userId: number) {
    try {
      // Пробуем резолвить через getInputEntity
      const ent = await this.client.getInputEntity(userId);
      if ("accessHash" in ent) {
        console.log(`User ${userId} accessHash = ${(ent as any).accessHash}`);
      } else {
        console.warn(`User ${userId} не получил accessHash, ent =`, ent);
      }
    } catch (e) {
      console.error(`Не удалось получить InputEntity для ${userId}:`, e);
    }
  }

  async getMessageCounters(
    chat: string | number,
    users: Array<string | number>
  ): Promise<Record<string, number>> {
    await this.connect();
    const peer = await this.resolvePeer(chat);

    if (peer instanceof Api.InputPeerChannel) {
      try {
        const full = await this.client.invoke(
          new Api.channels.GetFullChannel({ channel: peer })
        );
        console.log("Админ права:", (full.fullChat as any)?.adminRights);
      } catch {}
    }

    const peer1 = await this.resolvePeer(chat);
    if (!(peer1 instanceof Api.InputPeerChannel)) {
      throw new Error("getSearchCounters работает только для супергрупп/каналов");
    }
    const numericIds = users.filter((u): u is number => typeof u === "number");
    await this.warmUpUsersInChannel(peer1, numericIds);
    this.debugSession() 

        // После прогрева и перед GetSearchCounters
    for (const uid of numericIds) {
      await this.debugUserAccessHash(uid);
    }

    const userMap = await this.loadHistoryUsers(peer);
    const now = Math.floor(Date.now() / 1000);
    const dayAgo = now - 24 * 60 * 60;
    const result: Record<string, number> = {};

    for (const u of users) {
      let fromPeer: Api.InputPeerUser | null = null;
      if (typeof u === "string") {
        try {
          fromPeer = (await this.client.getInputEntity(u)) as Api.InputPeerUser;
        } catch {
          const usr = userMap.get(u.replace("@", ""));
          if (usr) fromPeer = new Api.InputPeerUser({ userId: usr.id as any, accessHash: (usr as any).accessHash as any });
        }
      } else {
        const usr = userMap.get(String(u));
        if (usr) fromPeer = new Api.InputPeerUser({ userId: usr.id as any, accessHash: (usr as any).accessHash as any });
      }

      if (!fromPeer) {
        console.warn(`Не удалось резолвить ${u}, пропускаем`);
        result[String(u)] = 0;
        continue;
      }

      const search = await this.client.invoke(
        new Api.messages.Search({
          peer,
          q: "",
          fromId: fromPeer,
          filter: new Api.InputMessagesFilterEmpty(),
          minDate: dayAgo,
          maxDate: now,
          offsetId: 0,
          addOffset: 0,
          limit: 1,
          maxId: 0,
          minId: 0,
          hash: 0n as any,
        })
      );

      let count = 0;
      if (search instanceof Api.messages.MessagesNotModified) count = search.count;
      else if (search instanceof Api.messages.Messages) count = (search as any).count ?? search.messages.length;
      else if (search instanceof Api.messages.MessagesSlice) count = search.count;

      result[String(u)] = count;
    }

    return result;
  }

  async getRecentMessages(chat: string | number, limit = 100) {
    await this.connect();
    const peer = await this.resolvePeer(chat);
    const res = await this.client.invoke(
      new Api.messages.GetHistory({
        peer,
        offsetId: 0,
        offsetDate: 0,
        addOffset: 0,
        limit: Math.min(limit, 100),
        maxId: 0,
        minId: 0,
        hash: 0n as any,
      })
    );
    if (res instanceof Api.messages.Messages || res instanceof Api.messages.MessagesSlice) {
      return res.messages as Api.Message[];
    }
    if (res instanceof Api.messages.ChannelMessages) {
      return res.messages as Api.Message[];
    }
    return [];
  }

  async resolveChannel(chat: string | number) {
    await this.connect();
    const peer = await this.resolvePeer(chat);
    if (peer instanceof Api.InputPeerChannel) {
      return await this.client.invoke(new Api.channels.GetFullChannel({ channel: peer }));
    } else {
      return await this.client.invoke(new Api.messages.GetFullChat({ chatId: (peer as Api.InputPeerChat).chatId }));
    }
  }

  async getMe() {
    await this.connect();
    return await this.client.getMe();
  }

  async disconnect() {
    if (this.isConnected) {
      await this.client.disconnect();
      this.isConnected = false;
    }
  }
}

export const telegramClient = new TGClient();
