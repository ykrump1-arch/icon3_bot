// ICON 3 — бот записи в Telegram
// Диалог: услуга -> мастер -> дата -> время (слот) -> имя -> телефон -> подтверждение

const TelegramBot = require('node-telegram-bot-api');

// ==== НАСТРОЙКА ====
const BOT_TOKEN = process.env.BOT_TOKEN || 'ВСТАВЬ_ТОКЕН_СЮДА';
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || 'ВСТАВЬ_CHAT_ID_СЮДА';

// Расписание студии: работает каждый день, 9:00–18:00, слоты по 30 минут
const WORK_START = '09:00';
const WORK_END = '18:00';
const SLOT_STEP_MIN = 30;
const DAYS_AHEAD = 7; // на сколько дней вперёд можно записаться
// ====================

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Состояние диалога (в памяти — сбрасывается при перезапуске бота)
const sessions = new Map();

// Занятые слоты: Map<dateKey, Set<'HH:MM'>>  например '2026-07-28' -> {'09:00','09:30'}
const bookings = new Map();

const SERVICES = [
  'Маникюр',
  'Маникюр с покрытием',
  'Педикюр',
  'Педикюр с покрытием',
  'Японский маникюр',
  'Медицинский педикюр (подология)',
  'Другое',
];

const WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, { step: 'idle' });
  return sessions.get(chatId);
}

function resetSession(chatId) {
  const session = sessions.get(chatId);
  // если слот был зарезервирован, но запись не подтверждена — освобождаем его
  releaseSlot(session);
  sessions.set(chatId, { step: 'idle' });
}

// ---- Время в Ташкенте (UTC+5), не зависит от таймзоны сервера Railway ----
function tashkentNow() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMs + 5 * 60 * 60000);
}

function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDateLabel(d) {
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function minutesToHHMM(mins) {
  const h = String(Math.floor(mins / 60)).padStart(2, '0');
  const m = String(mins % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Все возможные слоты дня, например ['09:00','09:30',...,'17:30']
function allDaySlots() {
  const startMin = hhmmToMinutes(WORK_START);
  const endMin = hhmmToMinutes(WORK_END);
  const slots = [];
  for (let t = startMin; t < endMin; t += SLOT_STEP_MIN) {
    slots.push(minutesToHHMM(t));
  }
  return slots;
}

// Свободные слоты на конкретный день (с учётом занятых и, если сегодня, прошедшего времени)
function getFreeSlots(dOffset) {
  const now = tashkentNow();
  const target = new Date(now);
  target.setDate(target.getDate() + dOffset);
  const key = dateKey(target);
  const taken = bookings.get(key) || new Set();

  let slots = allDaySlots().filter((s) => !taken.has(s));

  if (dOffset === 0) {
    const nowMin = now.getHours() * 60 + now.getMinutes();
    slots = slots.filter((s) => hhmmToMinutes(s) > nowMin);
  }

  return slots;
}

function reserveSlot(session) {
  if (!session.dateKey || !session.time) return;
  if (!bookings.has(session.dateKey)) bookings.set(session.dateKey, new Set());
  bookings.get(session.dateKey).add(session.time);
}

function releaseSlot(session) {
  if (!session || !session.dateKey || !session.time) return;
  const set = bookings.get(session.dateKey);
  if (set) set.delete(session.time);
}

// ---- /start ----
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  resetSession(chatId);
  bot.sendMessage(
    chatId,
    'Добро пожаловать в ICON 3 — территория красоты 🤍\n\nЗапишем вас онлайн. Выберите услугу:',
    {
      reply_markup: {
        inline_keyboard: SERVICES.map((s, i) => [{ text: s, callback_data: `service:${i}` }]),
      },
    }
  );
});

// ---- Клавиатура выбора даты ----
function buildDateKeyboard() {
  const now = tashkentNow();
  const rows = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const label = i === 0 ? `Сегодня, ${d.getDate()} ${MONTHS[d.getMonth()]}` : formatDateLabel(d);
    rows.push([{ text: label, callback_data: `date:${i}` }]);
  }
  return rows;
}

// ---- Клавиатура выбора времени (свободные слоты, по 3 в ряд) ----
function buildTimeKeyboard(dOffset) {
  const free = getFreeSlots(dOffset);
  const rows = [];
  for (let i = 0; i < free.length; i += 3) {
    rows.push(free.slice(i, i + 3).map((t) => ({ text: t, callback_data: `time:${t}` })));
  }
  return { rows, free };
}

// ---- Обработка нажатий на инлайн-кнопки ----
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = getSession(chatId);

  try {
    if (data.startsWith('service:')) {
      const index = parseInt(data.replace('service:', ''), 10);
      session.service = SERVICES[index];
      session.step = 'tier';
      await bot.editMessageText(`Услуга: ${session.service}\n\nВыберите мастера:`, {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Мастер', callback_data: 'tier:Мастер' }],
            [{ text: 'Топ-мастер', callback_data: 'tier:Топ-мастер' }],
          ],
        },
      });
    } else if (data.startsWith('tier:')) {
      session.tier = data.replace('tier:', '');
      session.step = 'date';
      await bot.editMessageText(
        `Услуга: ${session.service}\nМастер: ${session.tier}\n\nВыберите день записи:`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: { inline_keyboard: buildDateKeyboard() },
        }
      );
    } else if (data.startsWith('date:')) {
      const offset = parseInt(data.replace('date:', ''), 10);
      const now = tashkentNow();
      const target = new Date(now);
      target.setDate(target.getDate() + offset);

      session.dateOffset = offset;
      session.dateKey = dateKey(target);
      session.dateLabel = offset === 0 ? `Сегодня, ${target.getDate()} ${MONTHS[target.getMonth()]}` : formatDateLabel(target);
      session.step = 'time';

      const { rows, free } = buildTimeKeyboard(offset);

      if (free.length === 0) {
        await bot.editMessageText(
          `На ${session.dateLabel} свободных окон не осталось 😔\n\nВыберите другой день:`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: { inline_keyboard: buildDateKeyboard() },
          }
        );
        session.step = 'date';
      } else {
        await bot.editMessageText(
          `Услуга: ${session.service}\nМастер: ${session.tier}\nДень: ${session.dateLabel}\n\nВыберите свободное время:`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: { inline_keyboard: rows },
          }
        );
      }
    } else if (data.startsWith('time:')) {
      const time = data.replace('time:', '');
      const free = getFreeSlots(session.dateOffset);

      if (!free.includes(time)) {
        // кто-то другой успел занять этот слот раньше — обновляем список
        const { rows, free: freshFree } = buildTimeKeyboard(session.dateOffset);
        await bot.editMessageText(
          `Ой, это время только что заняли 😔\n\nВыберите другое время на ${session.dateLabel}:`,
          {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: { inline_keyboard: freshFree.length ? rows : buildDateKeyboard() },
          }
        );
        return bot.answerCallbackQuery(query.id);
      }

      session.time = time;
      reserveSlot(session); // сразу резервируем, чтобы никто другой не перехватил, пока клиент вводит данные
      session.step = 'name';
      await bot.editMessageText(
        `Услуга: ${session.service}\nМастер: ${session.tier}\nДата/время: ${session.dateLabel}, ${session.time}\n\nКак к вам обращаться? (напишите имя)`,
        { chat_id: chatId, message_id: query.message.message_id }
      );
    } else if (data === 'confirm:yes') {
      await sendBookingToOwner(chatId, session);
      await bot.editMessageText('Спасибо! Ваша запись отправлена администратору — скоро подтвердим 🤍', {
        chat_id: chatId,
        message_id: query.message.message_id,
      });
      sessions.set(chatId, { step: 'idle' }); // слот НЕ освобождаем — запись состоялась
    } else if (data === 'confirm:restart') {
      resetSession(chatId); // здесь слот освободится автоматически
      await bot.editMessageText('Хорошо, начнём заново. Отправьте /start', {
        chat_id: chatId,
        message_id: query.message.message_id,
      });
    }
  } catch (err) {
    console.error('Ошибка в callback_query:', err.message);
  }

  bot.answerCallbackQuery(query.id).catch(() => {});
});

// ---- Обработка обычных текстовых сообщений (имя, телефон) ----
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (session.step === 'name') {
    session.name = msg.text;
    session.step = 'phone';
    bot.sendMessage(chatId, 'Номер телефона для связи:', {
      reply_markup: {
        keyboard: [[{ text: 'Отправить номер 📱', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
  } else if (session.step === 'phone') {
    session.phone = msg.text;
    session.step = 'confirm';
    bot.sendMessage(chatId, buildConfirmText(session), {
      reply_markup: {
        remove_keyboard: true,
        inline_keyboard: [
          [{ text: '✅ Подтвердить', callback_data: 'confirm:yes' }],
          [{ text: '↩️ Начать заново', callback_data: 'confirm:restart' }],
        ],
      },
    });
  }
});

// ---- Контакт, отправленный кнопкой "Отправить номер" ----
bot.on('contact', (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  if (session.step === 'phone') {
    session.phone = msg.contact.phone_number;
    session.step = 'confirm';
    bot.sendMessage(chatId, buildConfirmText(session), {
      reply_markup: {
        remove_keyboard: true,
        inline_keyboard: [
          [{ text: '✅ Подтвердить', callback_data: 'confirm:yes' }],
          [{ text: '↩️ Начать заново', callback_data: 'confirm:restart' }],
        ],
      },
    });
  }
});

function buildConfirmText(session) {
  return (
    `Проверьте запись:\n\n` +
    `Услуга: ${session.service}\n` +
    `Мастер: ${session.tier}\n` +
    `Дата/время: ${session.dateLabel}, ${session.time}\n` +
    `Имя: ${session.name}\n` +
    `Телефон: ${session.phone}\n\n` +
    `Всё верно?`
  );
}

async function sendBookingToOwner(clientChatId, session) {
  const text =
    `💅 НОВАЯ ЗАПИСЬ — ICON 3 бот\n================\n\n` +
    `Услуга: ${session.service}\n` +
    `Мастер: ${session.tier}\n` +
    `Дата/время: ${session.dateLabel}, ${session.time}\n\n` +
    `Имя: ${session.name}\n` +
    `Телефон: ${session.phone}`;
  try {
    await bot.sendMessage(OWNER_CHAT_ID, text);
  } catch (err) {
    console.error('Не удалось отправить уведомление владельцу:', err.message);
  }
}

process.on('unhandledRejection', (err) => {
  console.error('Необработанная ошибка (бот не упал):', err.message);
});

console.log('ICON 3 booking bot запущен...');
