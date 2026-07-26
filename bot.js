// ICON 3 — бот записи в Telegram
// Диалог: услуга -> мастер -> дата/время -> имя -> телефон -> подтверждение

const TelegramBot = require('node-telegram-bot-api');

// ==== НАСТРОЙКА ====
// Токен бота — от @BotFather (создай ОТДЕЛЬНОГО бота для ICON 3, не переиспользуй свой личный)
const BOT_TOKEN = process.env.BOT_TOKEN || 'ВСТАВЬ_ТОКЕН_СЮДА';
// Чат/группа, куда падают готовые записи (id группы, отрицательное число)
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || 'ВСТАВЬ_CHAT_ID_СЮДА';
// ====================

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Простое хранилище состояния диалога в памяти (сбрасывается при перезапуске — этого достаточно для одной студии)
const sessions = new Map();

const SERVICES = [
  'Маникюр',
  'Маникюр с покрытием',
  'Педикюр',
  'Педикюр с покрытием',
  'Японский маникюр',
  'Медицинский педикюр (подология)',
  'Другое',
];

function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, { step: 'idle' });
  return sessions.get(chatId);
}

function resetSession(chatId) {
  sessions.set(chatId, { step: 'idle' });
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
        inline_keyboard: SERVICES.map((s) => [{ text: s, callback_data: `service:${s}` }]),
      },
    }
  );
});

// ---- Обработка нажатий на инлайн-кнопки ----
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = getSession(chatId);

  if (data.startsWith('service:')) {
    session.service = data.replace('service:', '');
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
    session.step = 'datetime';
    await bot.editMessageText(
      `Услуга: ${session.service}\nМастер: ${session.tier}\n\nНапишите желаемую дату и время (например: "28 июля, после 15:00")`,
      { chat_id: chatId, message_id: query.message.message_id }
    );
  } else if (data === 'confirm:yes') {
    await sendBookingToOwner(chatId, session);
    await bot.editMessageText('Спасибо! Ваша запись отправлена администратору — скоро подтвердим 🤍', {
      chat_id: chatId,
      message_id: query.message.message_id,
    });
    resetSession(chatId);
  } else if (data === 'confirm:restart') {
    resetSession(chatId);
    await bot.editMessageText('Хорошо, начнём заново. Отправьте /start', {
      chat_id: chatId,
      message_id: query.message.message_id,
    });
  }

  bot.answerCallbackQuery(query.id);
});

// ---- Обработка обычных текстовых сообщений (дата, имя, телефон) ----
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (session.step === 'datetime') {
    session.datetime = msg.text;
    session.step = 'name';
    bot.sendMessage(chatId, 'Как к вам обращаться? (имя)');
  } else if (session.step === 'name') {
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
    bot.sendMessage(
      chatId,
      `Проверьте запись:\n\nУслуга: ${session.service}\nМастер: ${session.tier}\nДата/время: ${session.datetime}\nИмя: ${session.name}\nТелефон: ${session.phone}\n\nВсё верно?`,
      {
        reply_markup: {
          remove_keyboard: true,
          inline_keyboard: [
            [{ text: '✅ Подтвердить', callback_data: 'confirm:yes' }],
            [{ text: '↩️ Начать заново', callback_data: 'confirm:restart' }],
          ],
        },
      }
    );
  }
});

// ---- Контакт, отправленный кнопкой "Отправить номер" ----
bot.on('contact', (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  if (session.step === 'phone') {
    session.phone = msg.contact.phone_number;
    session.step = 'confirm';
    bot.sendMessage(
      chatId,
      `Проверьте запись:\n\nУслуга: ${session.service}\nМастер: ${session.tier}\nДата/время: ${session.datetime}\nИмя: ${session.name}\nТелефон: ${session.phone}\n\nВсё верно?`,
      {
        reply_markup: {
          remove_keyboard: true,
          inline_keyboard: [
            [{ text: '✅ Подтвердить', callback_data: 'confirm:yes' }],
            [{ text: '↩️ Начать заново', callback_data: 'confirm:restart' }],
          ],
        },
      }
    );
  }
});

async function sendBookingToOwner(clientChatId, session) {
  const text =
    `💅 НОВАЯ ЗАПИСЬ — ICON 3 бот\n================\n\n` +
    `Услуга: ${session.service}\n` +
    `Мастер: ${session.tier}\n` +
    `Дата/время: ${session.datetime}\n\n` +
    `Имя: ${session.name}\n` +
    `Телефон: ${session.phone}`;
  await bot.sendMessage(OWNER_CHAT_ID, text);
}

console.log('ICON 3 booking bot запущен...');
