// utils/mtproto.ts
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import readline from "readline";
import fs from "fs";
import path from "path";
import { config } from "../config";

// Путь к файлу сессии
const SESSION_FILE = process.env.TG_SESSION_FILE || path.resolve(process.cwd(), ".telegram.session");

// Чтение сохранённой строки сессии
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

// Запись строки сессии на диск
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

// Вопросы в консоли
function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (ans) => { rl.close(); res(ans.trim()); }));
}

export class TGClient {
  private client: TelegramClient;
  private isConnected = false;
  private entityCache = new Map<string, any>();

  constructor() {
    const initial = readSessionFromFile();
    this.client = new TelegramClient(
      new StringSession(initial),
      Number(config.telegram_api_id),
      String(config.telegram_api_hash),
      { deviceModel: "bun-ts", appVersion: "1.0.0", systemVersion: "linux", connectionRetries: 5 }
    );
    // Автосохраняем при любых изменениях
    const saveOrig = this.client.session.save.bind(this.client.session);
    this.client.session.save = () => {
      const s = saveOrig();
      writeSessionToFile(s);
      return s;
    };
  }

  // Подключение и авторизация
  async connect() {
    if (this.isConnected) return;
    try {
      await this.client.connect();
      const me = await this.client.getMe();
      console.log("Подключились как:", (me as any)?.username ?? (me as any)?.id);
      // Сохраняем после возможных обновлений
      const cur = this.client.session.save();
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
  }

  // Минимальный прогрев диалогов (limit=10)
  private async warmUp() {
    const key = "dialogs";
    if (this.entityCache.has(key)) return;
    try {
      console.log("Прогрев диалогов...");
      const dlg = await this.client.getDialogs({ limit: 10 });
      console.log(`Прогрето диалогов: ${dlg.length}`);
    } catch (e) {
      console.warn("Не удалось прогреть диалоги:", e);
    }
    this.entityCache.set(key, true);
  }

  // Разрешение peer любого типа
  private async resolvePeer(chat: string | number): Promise<Api.TypeInputPeer> {
    const key = `peer_${chat}`;
    if (this.entityCache.has(key)) return this.entityCache.get(key);

    // строка (@username или ссылка)
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
        const ent = await this.client.getInputEntity(abs) as Api.InputPeerChannel;
        this.entityCache.set(key, ent);
        return ent;
      } catch {
        throw new Error("Нужен @username канала");
      }
    }
    if (id < 0) {
      const ent = await this.client.getInputEntity(-id) as Api.InputPeerChat;
      this.entityCache.set(key, ent);
      return ent;
    }
    const ent = await this.client.getInputEntity(id) as Api.InputPeerUser;
    this.entityCache.set(key, ent);
    return ent;
  }

  // Получение последних сообщений и сбор пользователей
  private async loadHistoryUsers(
    peer: Api.TypeInputPeer,
    limit = 100
  ): Promise<Map<string, Api.User>> {
    const result = await this.client.invoke(
      new Api.messages.GetHistory({
        peer,
        offsetId: 0,
        offsetDate: 0,
        addOffset: 0,
        limit: Math.min(limit, 100),
        maxId: 0,
        minId: 0,
        hash: 0n,
      })
    );
    const users = ((result as any).users as Api.User[]) || [];
    const map = new Map<string, Api.User>();
    for (const u of users) map.set(String(u.id), u);
    return map;
  }

  // Подсчёт за последние сутки
  async getMessageCounters(
    chat: string | number,
    users: Array<string | number>
  ): Promise<Record<string, number>> {
    await this.connect();
    const peer = await this.resolvePeer(chat);
    // Определяем тип чата (channel vs chat)
    let isChannel = peer instanceof Api.InputPeerChannel;

    // Если канал — можно получить права через channels.GetFullChannel
    if (isChannel) {
      try {
        const full = await this.client.invoke(
          new Api.channels.GetFullChannel({ channel: peer as Api.InputPeerChannel })
        );
        console.log("Админ права:", (full.fullChat as any)?.adminRights);
      } catch {
        // ignore
      }
    }

    // Загружаем историю для сбора access_hash пользователей
    const userMap = await this.loadHistoryUsers(peer);

    const now = Math.floor(Date.now() / 1000);
    const dayAgo = now - 24 * 60 * 60;
    const result: Record<string, number> = {};

    for (const u of users) {
      let fromPeer: Api.InputPeerUser | null = null;

      if (typeof u === "string") {
        try {
          fromPeer = await this.client.getInputEntity(u) as Api.InputPeerUser;
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
          filter: new Api.InputMessagesFilterEmpty({}),
          minDate: dayAgo,
          maxDate: now,
          offsetId: 0,
          addOffset: 0,
          limit: 1,
          maxId: 0,
          minId: 0,
          hash: 0n,
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

  // Получить последние сообщения
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
        hash: 0n,
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

  // Информация о канале или группе
  async resolveChannel(chat: string | number) {
    await this.connect();
    const peer = await this.resolvePeer(chat);
    if (peer instanceof Api.InputPeerChannel) {
      const full = await this.client.invoke(new Api.channels.GetFullChannel({ channel: peer }));
      return full;
    } else {
      // обычная группа
      const full = await this.client.invoke(new Api.messages.GetFullChat({ chatId: (peer as Api.InputPeerChat).chatId }));
      return full;
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
