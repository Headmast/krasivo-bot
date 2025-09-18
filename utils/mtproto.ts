// utils/mtproto.ts
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import readline from "readline";
import { config } from "../config";
import fs from "fs";
import path from "path";

// Путь к файлу сессии
const SESSION_FILE = process.env.TG_SESSION_FILE || path.resolve(process.cwd(), ".telegram.session");

// Улучшенная функция чтения с проверками:
function readSessionFromFile(): string {
  try {
    if (!fs.existsSync(SESSION_FILE)) {
      console.log(`Файл сессии не найден: ${SESSION_FILE}`);
      return "";
    }
    
    const stats = fs.statSync(SESSION_FILE);
    if (stats.size === 0) {
      console.log("Файл сессии пустой, требуется новая авторизация");
      return "";
    }
    
    const session = fs.readFileSync(SESSION_FILE, "utf8").trim();
    console.log(`Прочитана сессия: ${session.length} символов`);
    return session;
  } catch (e) {
    console.error("Ошибка чтения файла сессии:", e);
    return "";
  }
}

function writeSessionToFile(session: string) {
  try {
    if (!session || session.trim() === "") {
      console.warn("Попытка сохранить пустую сессию, пропускаем");
      return;
    }
    
    // Убедимся, что директория существует
    const dir = path.dirname(SESSION_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(SESSION_FILE, session, "utf8");
    console.log(`Сессия сохранена: ${SESSION_FILE} (${session.length} символов)`);
    
    // Проверка, что файл действительно записался
    const verification = fs.readFileSync(SESSION_FILE, "utf8").trim();
    if (verification !== session) {
      console.error("ОШИБКА: записанная сессия не совпадает с исходной!");
    }
  } catch (e) {
    console.warn("Не удалось сохранить сессию на диск:", e);
  }
}

// Утилита для интерактивных вопросов
function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

export class TGClient {
  private client: TelegramClient;
  private isConnected = false;
  private entityCache = new Map<string, any>(); // локальный кэш для минимизации повторных запросов

  constructor() {
    //const stringSession = new StringSession(process.env.TG_STRING_SESSION ?? "");
    const initialSession = readSessionFromFile(); 
    console.log("Прочитана сессия из файла:", initialSession ? "найдена" : "пустая"); 
    this.client = new TelegramClient(
      new StringSession(initialSession),
      Number(config.telegram_api_id),
      String(config.telegram_api_hash),
      {
        deviceModel: "bun-ts",
        appVersion: "1.0.0",
        systemVersion: "linux",
        connectionRetries: 5,
      }
    );

    // Автосохранение при любых изменениях сессии (если поддерживается)
    const originalSave = this.client.session.save.bind(this.client.session);
    this.client.session.save = () => {
      const result = originalSave();
      if (result && result !== readSessionFromFile()) {
        writeSessionToFile(result);
        console.log("Автосохранение сессии при изменении");
      }
      return result;
    };
  }

  // Проверка, нужна ли повторная авторизация
  async isSessionValid(): Promise<boolean> {
    try {
      await this.client.connect();
      await this.client.getMe(); // если сессия невалидна — упадёт здесь
      return true;
    } catch (e) {
      console.log("Сессия невалидна, требуется повторная авторизация:", e);
      return false;
    }
  }

  // Подключение и авторизация
  async connect() {
    if (this.isConnected) return;
    try {
      await this.client.connect(); // если сессия сохранена — достаточно connect() [attached_file:1]
      const me = await this.client.getMe();
      console.log("Успешно подключились к Telegram API как:", (me as any)?.username ?? (me as any)?.id);
      // ВАЖНО: сохраняем сессию после успешного connect(), так как она могла обновиться
      const currentSession = this.client.session.save();
      if (currentSession !== readSessionFromFile()) { // избегаем лишней записи, если не изменилась
        writeSessionToFile(currentSession);
        console.log("Сессия обновлена и сохранена после connect()");
      }
      this.isConnected = true;
      return me;
    } catch {
      console.log("Требуется авторизация в Telegram API");
      await this.startAuthentication(); // интерактивный логин [attached_file:1]
      this.isConnected = true;
    }
  }

  private async startAuthentication() {
    await this.client.start({
      phoneNumber: async () => await ask("Введите номер телефона (+7...): "),
      password: async () => await ask("Введите пароль двухфакторной аутентификации (если включён): "),
      phoneCode: async () => await ask("Введите код из Telegram: "),
      onError: (err) => console.error("Auth error:", err),
    });
    const saved = this.client.session.save();
    writeSessionToFile(saved);                                       // <-- сохраняем на диск
    console.log("String session обновлена и сохранена на диск.");
    // const saved = this.client.session.save();
    // console.log("String session (сохраните в переменную окружения TG_STRING_SESSION):\n", saved); // [attached_file:1]
  }

  // Минимальный прогрев кэша: только 10 последних диалогов для снижения FLOOD_WAIT [web:58][web:61]
  private async warmUpMinimal() {
    const cacheKey = "dialogs_warmed";
    if (this.entityCache.has(cacheKey)) return; // уже прогрели

    try {
      console.log("Прогрев минимального кэша диалогов...");
      const dialogs = await this.client.getDialogs({ limit: 100 }); // только 10 последних диалогов [web:58][web:61]
      this.entityCache.set(cacheKey, true);
      console.log(`Прогрето ${dialogs.length} диалогов для кэша сущностей`);
    } catch (e) {
      console.warn("Не удалось прогреть диалоги:", e);
    }
  }

  // Безопасное получение InputPeer для чата
  private async resolveChatPeer(chatIdOrName: string | number): Promise<Api.TypeInputPeer> {
    const cacheKey = `chat_${chatIdOrName}`;
    if (this.entityCache.has(cacheKey)) {
      return this.entityCache.get(cacheKey);
    }

    // 1) Если строка — пробуем напрямую (самый надёжный путь)
    if (typeof chatIdOrName === "string") {
      try {
        const entity = (await this.client.getInputEntity(chatIdOrName)) as Api.TypeInputPeer; // [web:43]
        this.entityCache.set(cacheKey, entity);
        return entity;
      } catch (e) {
        throw new Error(`Не удалось резолвить чат по строке "${chatIdOrName}": ${e}`);
      }
    }

    // 2) Числовые ID
    const idNum = Number(chatIdOrName);
    if (Number.isNaN(idNum)) throw new Error("Некорректный идентификатор чата");

    // 2.1) Канал/супергруппа (-100...)
    if (idNum.toString().startsWith("-100")) {
      const absId = Math.abs(idNum);
      await this.warmUpMinimal(); // минимальный прогрев [web:58]
      try {
        const entity = (await this.client.getInputEntity(absId)) as Api.InputPeerChannel; // [web:43]
        this.entityCache.set(cacheKey, entity);
        return entity;
      } catch {
        throw new Error("Не удалось резолвить канал по ID. Нужен username/ссылка '@name' или 'https://t.me/name'.");
      }
    }

    // 2.2) Обычная группа (<0, не -100...)
    if (idNum < 0) {
      const groupId = -idNum;
      await this.warmUpMinimal(); // минимальный прогрев [web:58]
      const entity = (await this.client.getInputEntity(groupId)) as Api.InputPeerChat; // [web:43]
      this.entityCache.set(cacheKey, entity);
      return entity;
    }

    // 2.3) Личный чат (>0)
    await this.warmUpMinimal(); // минимальный прогрев [web:58]
    try {
      const entity = (await this.client.getInputEntity(idNum)) as Api.InputPeerUser; // [web:43]
      this.entityCache.set(cacheKey, entity);
      return entity;
    } catch {
      throw new Error("Не удалось резолвить пользователя по ID. Нужен username/ссылка.");
    }
  }

  // Получение участников канала с ограничением для снижения FLOOD_WAIT [web:59][web:62]
  private async getChatParticipants(
    chatPeer: Api.InputPeerChannel,
    searchQuery = "",
    limit = 100
  ): Promise<Array<Api.User>> {
    const cacheKey = `participants_${chatPeer.channelId}_${searchQuery}_${limit}`;
    if (this.entityCache.has(cacheKey)) {
      return this.entityCache.get(cacheKey);
    }

    try {
      const result = await this.client.invoke(
        new Api.channels.GetParticipants({
          channel: chatPeer,
          filter: searchQuery 
            ? new Api.ChannelParticipantsSearch({ q: searchQuery }) 
            : new Api.ChannelParticipantsRecent({}), // только последние активные [web:62]
          offset: 0,
          limit: Math.min(limit, 100), // не больше 100, чтобы минимизировать FLOOD_WAIT [web:59][web:62]
          hash: 0n,
        })
      );
      const users = (result as any).users as Array<Api.User>;
      this.entityCache.set(cacheKey, users || []);
      return users || [];
    } catch (e) {
      console.warn("Не удалось получить участников:", e);
      return [];
    }
  }

  // Поиск InputPeerUser среди участников чата
  private async resolveUserFromChat(
    chatPeer: Api.InputPeerChannel,
    user: string | number
  ): Promise<Api.InputPeerUser | null> {
    // 1) Если строка — сначала прямой резолв
    if (typeof user === "string") {
      try {
        return (await this.client.getInputEntity(user)) as Api.InputPeerUser; // [web:43]
      } catch {
        // перейдём к поиску в участниках
      }
    }

    // 2) Поиск в участниках канала
    const searchQ = typeof user === "string" ? user.replace("@", "") : "";
    const participants = await this.getChatParticipants(chatPeer, searchQ, 100); // [web:59][web:62]

    if (typeof user === "number") {
      const found = participants.find(u => Number(u.id) === Number(user));
      if (found && "accessHash" in found) {
        return new Api.InputPeerUser({ 
          userId: found.id as any, 
          accessHash: (found as any).accessHash as any 
        });
      }
    } else if (participants.length > 0) {
      const found = participants[0];
      if (found && "accessHash" in found) {
        return new Api.InputPeerUser({ 
          userId: found.id as any, 
          accessHash: (found as any).accessHash as any 
        });
      }
    }

    return null;
  }

  // Получение последних 100 сообщений из чата [web:63][web:71]
  async getRecentMessages(chatIdOrName: string | number, limit = 100) {
    await this.connect();
    
    const peer = await this.resolveChatPeer(chatIdOrName);
    
    const result = await this.client.invoke(
      new Api.messages.GetHistory({
        peer,
        offsetId: 0,
        offsetDate: 0,
        addOffset: 0,
        limit: Math.min(limit, 100), // не больше 100 за раз [web:63][web:71]
        maxId: 0,
        minId: 0,
        hash: 0n, // BigInt обязателен [web:63][web:69]
      })
    );

    let messages: Api.Message[] = [];
    if (result instanceof Api.messages.Messages || result instanceof Api.messages.MessagesSlice) {
      messages = result.messages as Api.Message[];
    } else if (result instanceof Api.messages.ChannelMessages) {
      messages = result.messages as Api.Message[];
    }

    return messages;
  }

  // Подсчёт сообщений пользователей в чате за последние сутки [web:12][web:9]
  async getMessageCounters(
    chatIdOrName: string | number, 
    userIdsOrNames: Array<string | number>
  ): Promise<Record<string, number>> {
    await this.connect();

    console.log("Обрабатываем чат:", chatIdOrName);

    const peer = await this.resolveChatPeer(chatIdOrName);

    // Временные границы: последние 24 часа
    const nowSec = Math.floor(Date.now() / 1000);
    const dayAgoSec = nowSec - 24 * 60 * 60;

    const result: Record<string, number> = {};

    for (const u of userIdsOrNames) {
      let fromPeer: Api.InputPeerUser | null = null;

      // Пытаемся получить InputPeerUser
      if (typeof u === "string") {
        try {
          fromPeer = (await this.client.getInputEntity(u)) as Api.InputPeerUser; // [web:43]
        } catch {
          // fallback на поиск в участниках
          if (peer instanceof Api.InputPeerChannel) {
            fromPeer = await this.resolveUserFromChat(peer, u); // [web:62]
          }
        }
      } else {
        if (peer instanceof Api.InputPeerChannel) {
          fromPeer = await this.resolveUserFromChat(peer, u); // [web:62]
        }
      }

      if (!fromPeer) {
        console.warn(`Не удалось резолвить отправителя ${u}: пропускаем`);
        result[String(u)] = 0;
        continue;
      }

      // Поиск сообщений за сутки с точным count [web:12][web:9]
      const search = await this.client.invoke(
        new Api.messages.Search({
          peer,
          q: "",
          fromId: fromPeer,
          filter: new Api.InputMessagesFilterEmpty({}),
          minDate: dayAgoSec,   // только за сутки [web:12]
          maxDate: nowSec,      // по текущий момент [web:12]
          offsetId: 0,
          addOffset: 0,
          limit: 1,             // минимальный лимит, count вернётся отдельно [web:12]
          maxId: 0,
          minId: 0,
          hash: 0n,             // BigInt обязателен [web:9][web:12]
        })
      );

      let total = 0;
      if (search instanceof Api.messages.MessagesNotModified) {
        total = search.count;
      } else if (search instanceof Api.messages.Messages) {
        total = (search as any).count ?? search.messages.length;
      } else if (search instanceof Api.messages.MessagesSlice) {
        total = search.count; // точное число найденных сообщений [web:12]
      }

      result[String(u)] = total;
    }

    return result;
  }

  // Аналог resolveChannel для совместимости
  async resolveChannel(channelIdOrName: string | number) {
    const peer = await this.resolveChatPeer(channelIdOrName);
    if (!(peer instanceof Api.InputPeerChannel)) {
      throw new Error("Не канал/супергруппа");
    }

    const full = await this.client.invoke(
      new Api.channels.GetFullChannel({ channel: peer })
    );
    
    console.log("Канал найден:", (full.fullChat as any)?.about ?? (full.chats?.[0] as any)?.title ?? channelIdOrName);
    return full;
  }

  // Получение информации о себе
  async getMe() {
    await this.connect();
    return await this.client.getMe();
  }

  // Отключение
  async disconnect() {
    if (this.isConnected) {
      await this.client.disconnect();
      this.isConnected = false;
    }
  }
}

// Экспорт для совместимости с прежним кодом
export const telegramClient = new TGClient();
