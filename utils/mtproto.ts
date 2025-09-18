// src/telegramClient.ts
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import readline from "readline";
import { config } from "../config";

// Утилита для вопросов в консоли
function ask(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (ans) => { rl.close(); resolve(ans.trim()); }));
}

export class TGClient {
  private client: TelegramClient;
  private isConnected = false;

  constructor() {
    const stringSession = new StringSession(process.env.TG_STRING_SESSION ?? "");
    this.client = new TelegramClient(
      stringSession,
      Number(config.telegram_api_id),
      String(config.telegram_api_hash),
      {
        deviceModel: "bun-ts",
        appVersion: "1.0.0",
        systemVersion: "linux",
        connectionRetries: 5,
      }
    );
  }

  // Подключение/авторизация
  async connect() {
    if (this.isConnected) return;
    try {
      await this.client.connect(); // если сессия сохранена — хватит connect() [attached_file:1]
      const me = await this.client.getMe();
      console.log("Успешно подключились к Telegram API как:", (me as any)?.username ?? (me as any)?.id);
      this.isConnected = true;
      return me;
    } catch {
      console.log("Требуется авторизация в Telegram API");
      await this.startAuthentication(); // интерактивный логин и сохранение StringSession [attached_file:1]
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
    console.log("String session (сохраните в переменную окружения TG_STRING_SESSION):\n", saved); // экономит повторы логина [attached_file:1]
  }

  // Прогрев кэша сущностей: подгружаем диалоги и (опц.) пытаемся резолвить по username/ссылке
  // Это помогает получить access_hash для каналов/пользователей, чтобы потом работать по числовым ID. [web:39][web:43]
  private async warmUpEntities(hints?: Array<string | number>) {
    try {
      await this.client.getDialogs({}); // прогревает entities/access_hash для известных диалогов [web:39][web:43]
    } catch (e) {
      // ignore soft errors
    }
    if (hints && hints.length) {
      for (const h of hints) {
        try {
          if (typeof h === "string" && (h.startsWith("http") || h.startsWith("@"))) {
            await this.client.getInputEntity(h); // закеширует сущность при успехе [web:39][web:43]
          }
        } catch {
          // не критично; продолжим
        }
      }
    }
  }

  // Безопасное разрешение peer из chatId/username/ссылки
  // Поддерживает:
  // - строку "@name" или "https://t.me/name"
  // - числовой -100... (канал/супергруппа)
  // - числовой < 0 (legacy chat)
  // - положительный userId (требует прогрева, чтобы знать access_hash) [web:39][web:43]
  private async resolvePeerSafe(chat: string | number): Promise<Api.TypeInputPeer> {
    // 1) Если строка — пробуем напрямую, это самый надёжный путь. [web:43]
    if (typeof chat === "string") {
      await this.warmUpEntities([chat]); // резолв по строке прогреет access_hash [web:39][web:43]
      return (await this.client.getInputEntity(chat)) as Api.TypeInputPeer;
    }

    // 2) Числовые варианты
    const idNum = Number(chat);
    if (Number.isNaN(idNum)) {
      throw new Error("Некорректный идентификатор чата");
    }

    // 2.1) Канал/супергруппа (-100...)
    if (idNum.toString().startsWith("-100")) {
      const absId = Math.abs(idNum);
      // Прогреем диалоги, затем попробуем по числу
      await this.warmUpEntities();
      try {
        const ent = await this.client.getInputEntity(absId); // ожидаем InputPeerChannel с access_hash [web:43]
        return ent as Api.InputPeerChannel;
      } catch {
        // Если не вышло, потребуется username/ссылка, иначе MTProto не даст access_hash [web:39][web:43]
        throw new Error("Не удалось резолвить канал по числовому id. Передайте username/ссылку вида '@name' или 'https://t.me/name'.");
      }
    }

    // 2.2) Legacy group (<0 и не -100...)
    if (idNum < 0) {
      const groupId = -idNum;
      await this.warmUpEntities();
      const ent = await this.client.getInputEntity(groupId);
      return ent as Api.InputPeerChat;
    }

    // 2.3) Пользователь (>0). Без access_hash по голому id нельзя, прогреем и попробуем. [web:40][web:43]
    await this.warmUpEntities();
    try {
      const ent = await this.client.getInputEntity(idNum); // сработает, если пользователь встречался ранее [web:40][web:43]
      return ent as Api.InputPeerUser;
    } catch {
      throw new Error("Не удалось резолвить пользователя по числовому id. Нужен username/ссылка или сначала 'встретить' пользователя (диалоги/чат/контакты).");
    }
  }

  // Аналог resolveChannel: предпочитаем строку, иначе пробуем по числу с прогревом
  async resolveChannel(channelIdOrName: number | string) {
    try {
      const peer = await this.resolvePeerSafe(channelIdOrName); // вернёт InputPeerChannel [web:43]
      const full = await this.client.invoke(new Api.channels.GetFullChannel({ channel: peer as Api.InputChannel })); // получить детали [web:43]
      console.log("Канал найден:", (full.fullChat as any)?.about ?? (full.chats?.[0] as any)?.title ?? channelIdOrName);
      return full;
    } catch (e) {
      console.error("Ошибка при резолве канала:", e);
      throw e;
    }
  }

  // Подсчёт сообщений пользователя в чате: userId -> count
  // Важно: для fromId безопаснее передавать username/ссылку или предварительно прогреть сущность пользователя. [web:12][web:43]
  async getMessageCounters(chatIdOrName: number | string, userIdsOrNames: Array<number | string>) {
    await this.connect();

    console.log("Обрабатываем чат:", chatIdOrName);

    // 1) Получаем peer чата безопасно
    const peer = await this.resolvePeerSafe(chatIdOrName); // корректно вернёт InputPeer... [web:43]

    const result: Record<string, number> = {};

    for (const u of userIdsOrNames) {
      // 2) Получаем fromId безопасно
      let fromPeer: Api.TypeInputPeer;
      try {
        fromPeer = await this.resolvePeerSafe(u); // для строк надёжно; для чисел — при условии прогрева [web:39][web:40][web:43]
      } catch (e) {
        console.warn(`Не удалось резолвить отправителя ${u}:`, e);
        result[String(u)] = 0;
        continue;
      }

      // 3) Вызываем messages.Search с hash: 0n (BigInt), это вернёт общий count без пагинации [web:9][web:12]
      const search = await this.client.invoke(
        new Api.messages.Search({
          peer,
          q: "",
          fromId: fromPeer,
          filter: new Api.InputMessagesFilterEmpty({}),
          minDate: 0,
          maxDate: 0,
          offsetId: 0,
          addOffset: 0,
          limit: 1,
          maxId: 0,
          minId: 0,
          hash: 0n, // Важно: BigInt, не number [web:9][web:12]
        })
      );

      let total = 0;
      if (search instanceof Api.messages.MessagesNotModified) {
        total = search.count;
      } else if (search instanceof Api.messages.Messages) {
        total = (search as any).count ?? search.messages.length;
      } else if (search instanceof Api.messages.MessagesSlice) {
        total = search.count;
      }

      result[String(u)] = total;
    }

    return result;
  }
}

export const telegramClient = new TGClient();
