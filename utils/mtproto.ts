// src/telegramClient.ts
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import readline from "readline";

// Подтягиваем конфиг как и раньше
import { config } from "../config";

// Обёртка над readline
function ask(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (ans) => { rl.close(); resolve(ans.trim()); }));
}

export class TGClient {
  private client: TelegramClient;
  private isConnected = false;

  constructor() {
    // Рекомендуется хранить строковую сессию в .env, чтобы не логиниться каждый раз
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
      // Если уже есть сохранённая сессия — достаточно connect()
      await this.client.connect();

      // Проверим, что сессия валидна (аналог users.getFullUser self)
      const me = await this.client.getMe();
      console.log("Успешно подключились к Telegram API как:", (me as any)?.username ?? (me as any)?.id);
      this.isConnected = true;
      return me;
    } catch {
      // Нет сессии — запускаем интерактивную авторизацию (аналог вашего startAuthentication)
      console.log("Требуется авторизация в Telegram API");
      await this.startAuthentication();
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

    // Сохраняем строковую сессию, чтобы затем использовать connect()
    const saved = this.client.session.save();
    console.log("String session (сохраните в переменную окружения TG_STRING_SESSION):\n", saved);
  }

  // Разрешение peer по вашему chatId формату (с сохранением вашей логики -100 / group / user)
  private async resolvePeer(chatId: number): Promise<Api.TypeInputPeer> {
    // В GramJS лучше использовать getInputEntity на строковый username/ссылку/числовой id.
    // Но оставим совместимость с вашей логикой:
    if (chatId.toString().startsWith("-100")) {
      // Супергруппа/канал: в Telegram numeric channel id — это abs(chatId)
      const channelId = Math.abs(Number(chatId));
      // Получим сущность через resolve, чтобы достать access_hash
      const entity = await this.client.getInputEntity(channelId);
      // entity уже InputPeerChannel с корректным access_hash
      return entity as Api.InputPeerChannel;
    } else if (chatId < 0) {
      // Обычная группа (legacy chats)
      const groupId = -chatId;
      const entity = await this.client.getInputEntity(groupId);
      return entity as Api.InputPeerChat;
    } else {
      // Личный пользователь
      const entity = await this.client.getInputEntity(chatId);
      return entity as Api.InputPeerUser;
    }
  }

  // Аналог вашего resolveChannel, но безопаснее через getInputEntity
  async resolveChannel(channelId: number) {
    // Для -100... берём абсолютный id
    const absId = Math.abs(Number(channelId));
    const entity = await this.client.getEntity(absId);
    console.log("Канал найден:", (entity as any)?.title ?? (entity as any)?.username ?? absId);
    return entity;
  }

  // Подсчёт сообщений пользователя в чате
  // Возвращает объект: userId -> count
  async getMessageCounters(chatId: number, userIds: number[]) {
    await this.connect();

    console.log(`Обрабатываем chatId: ${chatId}`);

    // Разрешаем peer
    const peer = await this.resolvePeer(chatId);

    // Для каждого пользователя считаем через messages.search с fromId
    // Это даёт точный общий count, не перебирая все страницы
    const result: Record<number, number> = {};

    for (const userId of userIds) {
      const from = await this.client.getInputEntity(userId);

      const search = await this.client.invoke(
        new Api.messages.Search({
          peer,
          q: "", // пустой запрос — учитывать все сообщения, подпадающие под фильтр
          fromId: from,
          filter: new Api.InputMessagesFilterEmpty({}),
          minDate: 0,
          maxDate: 0,
          offsetId: 0,
          addOffset: 0,
          limit: 1, // достаточно минимального; count вернётся отдельно
          maxId: 0,
          minId: 0,
          hash: 0n,
        })
      );

      // Достаём общий count (MessagesSlice/NotModified содержит count)
      let total = 0;
      if (search instanceof Api.messages.MessagesNotModified) {
        total = search.count;
      } else if (search instanceof Api.messages.Messages) {
        total = (search as any).count ?? search.messages.length;
      } else if (search instanceof Api.messages.MessagesSlice) {
        total = search.count;
      }

      result[userId] = total;
    }

    // Если нужен разбив по типам (как у getSearchCounters), можно отдельно вызвать:
    // const counters = await this.client.invoke(new Api.messages.GetSearchCounters({
    //   peer,
    //   filters: [new Api.InputMessagesFilterEmpty({})],
    // }));
    // Он вернёт массив { filter, count }, но без фильтра fromId.

    return result;
  }
}

// Экспорт совместимый с прежним кодом
export const telegramClient = new TGClient();