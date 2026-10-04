const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const express = require('express');
const path = require('path');

// ============ НАСТРОЙКИ ============
const BOT_TOKEN = process.env.BOT_TOKEN || 'ТВОЙ_ТОКЕН_ЗДЕСЬ';
const PORT = process.env.PORT || 3000;
const WEBAPP_URL = process.env.WEBAPP_URL || `http://localhost:${PORT}`;

// ============ ИНИЦИАЛИЗАЦИЯ ============
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ============ ЛОГИКА ИГРЫ ============
// Правила из файла "Малый-большой-равный"
// 1-9, у каждого 4 победы и 4 поражения

function getCategory(n) {
  if (n <= 3) return 'small';
  if (n <= 6) return 'equal';
  return 'big';
}

function isEven(n) { return n % 2 === 0; }

function compare(a, b) {
  if (a === b) return 'draw';
  
  // 1. Маленькое бьёт большое
  if (getCategory(a) === 'small' && getCategory(b) === 'big') return 'a';
  if (getCategory(b) === 'small' && getCategory(a) === 'big') return 'b';
  
  // 2. Большое чёт бьёт маленькое нечёт
  if (getCategory(a) === 'big' && isEven(a) && getCategory(b) === 'small' && !isEven(b)) return 'a';
  if (getCategory(b) === 'big' && isEven(b) && getCategory(a) === 'small' && !isEven(a)) return 'b';
  
  // 3. Маленькое чёт бьёт большое нечёт
  if (getCategory(a) === 'small' && isEven(a) && getCategory(b) === 'big' && !isEven(b)) return 'a';
  if (getCategory(b) === 'small' && isEven(b) && getCategory(a) === 'big' && !isEven(a)) return 'b';
  
  // 4. Одинаковый чёт — ничья (уже обработано a===b, но разные числа одной категории)
  // 5. Мал. чёт vs мал. нечёт — меньшее побеждает
  if (getCategory(a) === 'small' && getCategory(b) === 'small') {
    if (isEven(a) && !isEven(b)) return a < b ? 'a' : 'b';
    if (!isEven(a) && isEven(b)) return a < b ? 'a' : 'b';
    // оба чёт или оба нечёт — ничья (по правилам "одинаковый чёт — ничья")
    return 'draw';
  }
  
  // 6. Бол. чёт vs бол. нечёт — нечёт побеждает
  if (getCategory(a) === 'big' && getCategory(b) === 'big') {
    if (isEven(a) && !isEven(b)) return 'b';
    if (!isEven(a) && isEven(b)) return 'a';
    return 'draw';
  }
  
  // 7. Равный чёт vs равный нечёт — ничья
  if (getCategory(a) === 'equal' && getCategory(b) === 'equal') return 'draw';
  
  // 8. Исключение: 6 бьёт 9
  if (a === 6 && b === 9) return 'a';
  if (b === 6 && a === 9) return 'b';
  
  // Кросс-категории, не покрытые выше (equal vs small, equal vs big)
  // Если равный против малого — равный побеждает (большее число)
  // Если равный против большого — большое побеждает
  // Это логика по умолчанию для оставшихся комбинаций
  if (getCategory(a) === 'equal' && getCategory(b) === 'small') return 'a';
  if (getCategory(b) === 'equal' && getCategory(a) === 'small') return 'b';
  if (getCategory(a) === 'equal' && getCategory(b) === 'big') return 'b';
  if (getCategory(b) === 'equal' && getCategory(a) === 'big') return 'a';
  
  return 'draw';
}

function getResultText(a, b) {
  const res = compare(a, b);
  if (res === 'draw') return 'draw';
  if (res === 'a') return 'win_a';
  return 'win_b';
}

// ============ ХРАНИЛИЩА ============

// Игры в группах через команды бота
const groupGames = {}; // { chatId: { player1, player2, p1Move, p2Move, status } }

// Онлайн-комнаты через WebSocket
const rooms = {}; // { roomId: { player1: ws, player2: ws, p1Move, p2Move, p1Name, p2Name, p1Score, p2Score, round } }
const waitingPlayers = []; // Очередь игроков, ищущих соперника

// ============ БОТ: КОМАНДЫ ============

// Команда /start — приветствие
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  
  if (isGroup) {
    bot.sendMessage(chatId, 
      `🎮 *Малый-большой-равный*\n\n` +
      `Напиши /game чтобы начать игру в группе!\n` +
      `Два игрока пишут /game — и начинается раунд.\n\n` +
      `Также можно открыть веб-версию: /web`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🤖 Играть с ботом', callback_data: 'play_bot' }],
        [{ text: '🌐 Открыть веб-версию', web_app: { url: WEBAPP_URL } }],
        [{ text: '📋 Правила', callback_data: 'rules' }]
      ]
    }
  };
  
  bot.sendMessage(chatId,
    `🎮 *Малый-большой-равный*\n\n` +
    `Раз, два, три!\n` +
    `⚖️ У каждого числа 50% побед\n\n` +
    `Выбери режим игры:`,
    { parse_mode: 'Markdown', ...keyboard }
  );
});

// Команда /game — старт игры (работает в ЛС и в группе)
bot.onText(/\/game/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userName = msg.from.first_name;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  
  // В ЛС — открываем веб-версию с ботом
  if (!isGroup) {
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎮 Играть в вебе', web_app: { url: WEBAPP_URL } }],
          [{ text: '🤖 Играть с ботом здесь', callback_data: 'play_bot_chat' }]
        ]
      }
    };
    bot.sendMessage(chatId,
      `🎮 Выбери способ игры:\n\n` +
      `1. *Веб-версия* — красивый интерфейс с анимациями\n` +
      `2. *В чате* — игра прямо здесь кнопками`,
      { parse_mode: 'Markdown', ...keyboard }
    );
    return;
  }
  
  // В ГРУППЕ — текстовая игра на числа
  
  // Проверяем, не идёт ли уже игра
  if (groupGames[chatId]) {
    const game = groupGames[chatId];
    
    // Тот же игрок пытается начать заново
    if (game.player1.id === userId) {
      bot.sendMessage(chatId, `${userName}, ты уже в игре! Жди соперника.`);
      return;
    }
    
    // Если ждут второго игрока — это второй!
    if (game.status === 'waiting' && !game.player2) {
      game.player2 = { id: userId, name: userName };
      game.status = 'playing';
      
      bot.sendMessage(chatId,
        `✅ *Игра началась!*\n\n` +
        `👤 ${game.player1.name} vs ${game.player2.name}\n\n` +
        `Каждый пишет число от 1 до 9 в этот чат.\n` +
        `Я запомню ход каждого и покажу результат, когда оба выберут.\n\n` +
        `⚖️ Правила: /rules`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    // Игра уже идёт с двумя игроками
    if (game.status === 'playing') {
      bot.sendMessage(chatId, `⚠️ В этом чате уже идёт игра! Дождитесь окончания.`);
      return;
    }
  }
  
  // Создаём новую игру
  groupGames[chatId] = {
    player1: { id: userId, name: userName },
    player2: null,
    p1Move: null,
    p2Move: null,
    status: 'waiting'
  };
  
  bot.sendMessage(chatId,
    `🎮 *Игра создана!*\n\n` +
    `👤 ${userName} ждёт соперника.\n\n` +
    `Второй игрок, напиши /game чтобы присоединиться!`,
    { parse_mode: 'Markdown' }
  );
});

// Команда /rules — правила
bot.onText(/\/rules/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `📋 *Правила «Малый-большой-равный»*\n\n` +
    `Числа 1-9. У каждого 4 победы и 4 поражения.\n\n` +
    `1. Маленькое бьёт большое (2 > 8, 1 > 9)\n` +
    `2. Большое чёт бьёт маленькое нечёт (8 > 3, 6 > 1)\n` +
    `3. Маленькое чёт бьёт большое нечёт (2 > 9, 4 > 7)\n` +
    `4. Одинаковый чёт — ничья (2 = 2, 8 = 8)\n` +
    `5. Мал. чёт vs мал. нечёт — меньшее побеждает (1 > 2, 3 > 4)\n` +
    `6. Бол. чёт vs бол. нечёт — нечёт побеждает (9 > 8, 7 > 6)\n` +
    `7. Равный чёт vs равный нечёт — ничья (3 = 5, 4 = 6)\n` +
    `8. Исключение: 6 бьёт 9`,
    { parse_mode: 'Markdown' }
  );
});

// Команда /web — ссылка на веб-версию
bot.onText(/\/web/, (msg) => {
  const chatId = msg.chat.id;
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎮 Открыть игру', web_app: { url: WEBAPP_URL } }]
      ]
    }
  };
  bot.sendMessage(chatId, `🎮 Открыть веб-версию игры:`, keyboard);
});

// ============ БОТ: ИГРА В ЧАТЕ (callback_query) ============

bot.on('callback_query', (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const userName = query.from.first_name;
  
  if (data === 'play_bot' || data === 'play_bot_chat') {
    const keyboard = {
      inline_keyboard: [
        [{ text: '1', callback_data: 'num_1' }, { text: '2', callback_data: 'num_2' }, { text: '3', callback_data: 'num_3' }],
        [{ text: '4', callback_data: 'num_4' }, { text: '5', callback_data: 'num_5' }, { text: '6', callback_data: 'num_6' }],
        [{ text: '7', callback_data: 'num_7' }, { text: '8', callback_data: 'num_8' }, { text: '9', callback_data: 'num_9' }]
      ]
    };
    bot.sendMessage(chatId, `🎲 Выбери число от 1 до 9:`, keyboard);
    return;
  }
  
  if (data === 'rules') {
    bot.sendMessage(chatId,
      `📋 Правила: каждое число 1-9 имеет 4 победы и 4 поражения.\n` +
      `Подробнее: /rules`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  // Игра с ботом в чате: выбор числа
  if (data.startsWith('num_')) {
    const playerNum = parseInt(data.split('_')[1]);
    const botNum = Math.floor(Math.random() * 9) + 1;
    
    const res = compare(playerNum, botNum);
    let resultText = '';
    
    if (res === 'draw') {
      resultText = `🤝 Ничья!`;
    } else if (res === 'a') {
      resultText = `🎉 Ты победил!`;
    } else {
      resultText = `😔 Бот победил!`;
    }
    
    bot.editMessageText(
      `Ты: ${playerNum} vs Бот: ${botNum}\n\n${resultText}`,
      { chat_id: chatId, message_id: query.message.message_id }
    );
    
    const keyboard = {
      inline_keyboard: [
        [{ text: '🔄 Ещё раз', callback_data: 'play_bot_chat' }],
        [{ text: '📋 Правила', callback_data: 'rules' }]
      ]
    };
    bot.sendMessage(chatId, `Сыграть ещё?`, keyboard);
    bot.answerCallbackQuery(query.id);
    return;
  }
  
  bot.answerCallbackQuery(query.id);
});

// ============ БОТ: ИГРА В ГРУППЕ (текстовые числа) ============

bot.on('message', (msg) => {
  if (!msg.text) return;
  
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text.trim();
  
  // Игнорируем команды
  if (text.startsWith('/')) return;
  
  // Проверяем, есть ли активная игра в этом чате
  const game = groupGames[chatId];
  if (!game || game.status !== 'playing') return;
  
  // Проверяем, участник ли этот игрок
  let playerKey = null;
  if (game.player1 && game.player1.id === userId) playerKey = 'p1';
  else if (game.player2 && game.player2.id === userId) playerKey = 'p2';
  
  if (!playerKey) return; // Не участник — игнорируем
  
  // Уже сделал ход
  if (game[playerKey + 'Move'] !== null) return;
  
  // Парсим число
  const num = parseInt(text);
  if (isNaN(num) || num < 1 || num > 9) return;
  
  // Записываем ход
  game[playerKey + 'Move'] = num;
  
  // Удаляем сообщение игрока (чтобы соперник не увидел)
  bot.deleteMessage(chatId, msg.message_id).catch(() => {});
  
  // Проверяем, оба ли сделали ход
  if (game.p1Move !== null && game.p2Move !== null) {
    // Определяем победителя
    const res = compare(game.p1Move, game.p2Move);
    let resultText = '';
    
    if (res === 'draw') {
      resultText = `🤝 Ничья!`;
    } else if (res === 'a') {
      resultText = `🎉 ${game.player1.name} победил!`;
    } else {
      resultText = `🎉 ${game.player2.name} победил!`;
    }
    
    bot.sendMessage(chatId,
      `🏆 *Результат раунда*\n\n` +
      `👤 ${game.player1.name}: ${game.p1Move}\n` +
      `👤 ${game.player2.name}: ${game.p2Move}\n\n` +
      `${resultText}\n\n` +
      `🔄 Напишите /game для нового раунда`,
      { parse_mode: 'Markdown' }
    );
    
    // Удаляем игру
    delete groupGames[chatId];
  } else {
    // Один ход сделан — тихо ждём второго
    bot.sendMessage(chatId, `✅ ${userName} сделал ход. Ждём соперника...`)
      .then(sent => {
        setTimeout(() => bot.deleteMessage(chatId, sent.message_id).catch(() => {}), 3000);
      });
  }
});

// ============ WEBSOCKET: ОНЛАЙН-ИГРА ============

wss.on('connection', (ws) => {
  console.log('Новое WebSocket подключение');
  
  let currentRoom = null;
  let playerName = 'Игрок';
  let playerId = null;
  
  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message); } catch (e) { return; }
    
    // Инициализация игрока
    if (data.type === 'init') {
      playerName = data.name || 'Игрок';
      playerId = data.id || Date.now().toString();
      ws.playerName = playerName;
      ws.playerId = playerId;
      
      // Ищем соперника или ставим в очередь
      if (waitingPlayers.length > 0) {
        const opponent = waitingPlayers.shift();
        const roomId = `room_${Date.now()}`;
        
        rooms[roomId] = {
          player1: opponent.ws,
          player2: ws,
          p1Move: null,
          p2Move: null,
          p1Name: opponent.ws.playerName,
          p2Name: playerName,
          p1Score: 0,
          p2Score: 0,
          round: 1
        };
        
        opponent.ws.roomId = roomId;
        ws.roomId = roomId;
        currentRoom = roomId;
        
        // Оповещаем обоих
        opponent.ws.send(JSON.stringify({
          type: 'match_found',
          room: roomId,
          opponent: playerName,
          youAre: 'player1'
        }));
        
        ws.send(JSON.stringify({
          type: 'match_found',
          room: roomId,
          opponent: opponent.ws.playerName,
          youAre: 'player2'
        }));
        
        console.log(`Комната ${roomId}: ${rooms[roomId].p1Name} vs ${rooms[roomId].p2Name}`);
      } else {
        waitingPlayers.push({ ws, name: playerName });
        ws.send(JSON.stringify({ type: 'searching' }));
        console.log(`Игрок ${playerName} в очереди`);
      }
    }
    
    // Ход игрока
    if (data.type === 'move') {
      const room = rooms[currentRoom || data.room];
      if (!room) return;
      
      let move = parseInt(data.move);
      if (isNaN(move) || move < 1 || move > 9) return;
      
      let playerKey = null;
      if (room.player1 === ws) playerKey = 'p1';
      else if (room.player2 === ws) playerKey = 'p2';
      
      if (!playerKey) return;
      if (room[playerKey + 'Move'] !== null) return; // Уже ходил
      
      room[playerKey + 'Move'] = move;
      
      // Оповещаем соперника, что ход сделан
      const opponent = playerKey === 'p1' ? room.player2 : room.player1;
      opponent.send(JSON.stringify({
        type: 'opponent_moved'
      }));
      
      // Проверяем, оба ли сделали ход
      if (room.p1Move !== null && room.p2Move !== null) {
        const res = compare(room.p1Move, room.p2Move);
        
        let winner = 'draw';
        if (res === 'a') { winner = 'p1'; room.p1Score++; }
        else if (res === 'b') { winner = 'p2'; room.p2Score++; }
        
        const resultMsg = {
          type: 'round_result',
          p1Move: room.p1Move,
          p2Move: room.p2Move,
          winner: winner,
          p1Score: room.p1Score,
          p2Score: room.p2Score,
          round: room.round
        };
        
        room.player1.send(JSON.stringify(resultMsg));
        room.player2.send(JSON.stringify(resultMsg));
        
        // Сброс для следующего раунда
        room.p1Move = null;
        room.p2Move = null;
        room.round++;
      }
    }
    
    // Ремматч
    if (data.type === 'rematch') {
      const room = rooms[currentRoom || data.room];
      if (!room) return;
      
      // Сброс счёта
      room.p1Score = 0;
      room.p2Score = 0;
      room.p1Move = null;
      room.p2Move = null;
      room.round = 1;
      
      room.player1.send(JSON.stringify({ type: 'rematch' }));
      room.player2.send(JSON.stringify({ type: 'rematch' }));
    }
    
    // Отключение / выход
    if (data.type === 'leave') {
      const room = rooms[currentRoom];
      if (room) {
        const opponent = room.player1 === ws ? room.player2 : room.player1;
        opponent.send(JSON.stringify({ type: 'opponent_left' }));
        delete rooms[currentRoom];
      }
    }
  });
  
  ws.on('close', () => {
    // Удаляем из очереди ожидания
    const idx = waitingPlayers.findIndex(p => p.ws === ws);
    if (idx >= 0) waitingPlayers.splice(idx, 1);
    
    // Оповещаем соперника об отключении
    if (currentRoom && rooms[currentRoom]) {
      const room = rooms[currentRoom];
      const opponent = room.player1 === ws ? room.player2 : room.player1;
      if (opponent && opponent.readyState === WebSocket.OPEN) {
        opponent.send(JSON.stringify({ type: 'opponent_left' }));
      }
      delete rooms[currentRoom];
    }
    console.log('WebSocket отключение');
  });
});

// ============ ЗАПУСК ============
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Бот активен, токен: ${BOT_TOKEN ? 'установлен' : 'НЕ УСТАНОВЛЕН'}`);
  console.log(`Веб-версия: ${WEBAPP_URL}`);
});

// Обработка ошибок
bot.on('polling_error', (error) => {
  console.error('Ошибка бота:', error.message);
});
