require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const GROQ_KEY = process.env.GROQ_API_KEY;
const BET_TIME = 30;
const CHALLENGE_TIME = 20;
const START_BALANCE = 500;
const MAX_BET = 500;
const MIN_BET = 50;

const CATEGORIES = {
  football: 'كرة القدم',
  general_info: 'معلومات عامة',
  islamic: 'إسلاميات',
  anime: 'الأنمي'
};

async function generateQuestions(catIds, previous = []) {
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY missing');
  const catList = catIds.map(c => CATEGORIES[c] || c).join('، ');

  const recent = previous.slice(-30);
  const avoidBlock = recent.length > 0
    ? `\n⛔ ممنوع تكرار أي سؤال من دول:\n${recent.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n`
    : '';

  const prompt = `أعد 5 أسئلة معلومات عامة بالعربية من الفئات: ${catList}.
${avoidBlock}
شروط:
- سؤال مفتوح بإجابة واحدة قصيرة ومحددة
- ممنوع أي اختيارات أو بدائل
- الإجابة كلمة أو كلمتين أو رقم
- كل النصوص بالعربية الفصحى
- نوّع الصعوبة

أعد JSON فقط:
{"questions":[{"category":"...","question":"...","answer":"..."},...5 أسئلة]}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 1.0,
        max_tokens: 1800
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Groq HTTP ${res.status}: ${txt.slice(0, 120)}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    const list = Array.isArray(parsed.questions) ? parsed.questions : [];

    return list.map(q => ({
      category: String(q.category || '').trim(),
      question: String(q.question || '').trim(),
      answer: String(q.answer || '').trim()
    })).filter(q => q.question.length > 3 && q.answer.length > 0);
  } finally {
    clearTimeout(timeout);
  }
}

async function judgeAnswer(question, correctAnswer, playerAnswer) {
  if (!GROQ_KEY) return false;
  const clean = String(playerAnswer || '').trim();
  if (!clean) return false;

  const prompt = `سؤال: ${question}
الإجابة الصحيحة: ${correctAnswer}
إجابة اللاعب: ${clean}

هل إجابة اللاعب صحيحة (نفس المعنى ولو مكتوبة بشكل مختلف)؟ رد بـ JSON فقط: {"correct":true} أو {"correct":false}`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 50
      })
    });
    if (!res.ok) return false;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    return !!parsed.correct;
  } catch (e) {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════ */
const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function sanitize(str, max = 30) {
  return String(str || '').slice(0, max).replace(/[<>&"']/g, '');
}

function publicRoom(room) {
  // ✅ السؤال بيظهر بس في المراحل اللي المفروض يبان فيها (مش في المراهنة)
  const questionVisible = ['answering', 'challenge', 'scoring', 'reveal'].includes(room.phase);

  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, balance: p.balance, eliminated: p.eliminated
    })),
    categories: room.categories,
    round: room.round,
    phase: room.phase,
    currentQuestion: room.currentQuestion ? {
      category: room.currentQuestion.category,
      question: questionVisible ? room.currentQuestion.question : null
    } : null,
    bets: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, bet: p.bet, hasAnswered: !!(p.answer && p.answer.trim())
    })),
    challenges: Object.values(room.players)
      .filter(p => p.challengeTarget)
      .map(p => ({ id: p.id, name: p.name, target: p.challengeTarget, amount: p.challengeAmount })),
    pot: room.currentPot,
    betTimeLeft: room.betTimeLeft,
    challengeTimeLeft: room.challengeTimeLeft,
    lastRoundResults: room.lastRoundResults || null,
    winner: room.winner || null,
    messages: room.messages ? room.messages.slice(-60) : []
  };
}

function broadcast(room) {
  io.to(room.code).emit('room-update', publicRoom(room));
}

/* ═══════════════════════════════════════════════════════════════
   🎯 Game Flow
   ═══════════════════════════════════════════════════════════════ */
function beginRound(room) {
  if (room.questions.length === 0) {
    refillQuestions(room);
    return;
  }

  const q = room.questions.shift();
  room.askedQuestions.push(q.question);

  room.currentQuestion = q;
  room.phase = 'betting';
  room.betTimeLeft = BET_TIME;
  room.currentPot = 0;
  room.lastRoundResults = null;

  Object.values(room.players).forEach(p => {
    p.bet = 0;
    p.answer = '';
    p.correct = null;
    p.challengeTarget = null;
    p.challengeAmount = 0;
    p.betConfirmed = false;
  });

  broadcast(room);
  startBetTimer(room);
}

function startBetTimer(room) {
  clearBetTimer(room);
  room.betTimer = setInterval(() => {
    if (room.phase !== 'betting') { clearBetTimer(room); return; }
    room.betTimeLeft--;
    if (room.betTimeLeft <= 0) {
      clearBetTimer(room);
      endBettingPhase(room);
    } else {
      broadcast(room);
    }
  }, 1000);
}

function clearBetTimer(room) {
  if (room.betTimer) { clearInterval(room.betTimer); room.betTimer = null; }
}

function endBettingPhase(room) {
  Object.values(room.players).forEach(p => {
    if (p.eliminated) return;
    if (!p.bet || p.bet < 0) p.bet = 0;
  });

  room.currentPot = Object.values(room.players)
    .filter(p => !p.eliminated)
    .reduce((sum, p) => sum + p.bet, 0);

  // deduct bets from balance temporarily (they'll be refunded if correct)
  Object.values(room.players).forEach(p => {
    if (p.eliminated) return;
    p.balance -= p.bet;
  });

  room.phase = 'answering';
  broadcast(room);
}

function endAnsweringPhase(room) {
  if (room.phase !== 'answering') return;
  room.phase = 'challenge';
  room.challengeTimeLeft = CHALLENGE_TIME;
  broadcast(room);
  startChallengeTimer(room);
}

function startChallengeTimer(room) {
  clearChallengeTimer(room);
  room.challengeTimer = setInterval(() => {
    if (room.phase !== 'challenge') { clearChallengeTimer(room); return; }
    room.challengeTimeLeft--;
    if (room.challengeTimeLeft <= 0) {
      clearChallengeTimer(room);
      resolveScoring(room);
    } else {
      broadcast(room);
    }
  }, 1000);
}

function clearChallengeTimer(room) {
  if (room.challengeTimer) { clearInterval(room.challengeTimer); room.challengeTimer = null; }
}

async function resolveScoring(room) {
  clearChallengeTimer(room);
  if (room.phase !== 'challenge') return;
  room.phase = 'scoring';
  broadcast(room);

  const players = Object.values(room.players).filter(p => !p.eliminated);

  for (const p of players) {
    if (!p.answer || p.answer.trim().length === 0) {
      p.correct = false;
      continue;
    }
    p.correct = await judgeAnswer(room.currentQuestion.question, room.currentQuestion.answer, p.answer);
  }

  const winners = players.filter(p => p.correct && p.bet > 0);
  const results = [];

  if (winners.length > 0) {
    const totalBet = winners.reduce((s, p) => s + p.bet, 0);
    winners.forEach(p => {
      const share = Math.floor((p.bet / totalBet) * room.currentPot);
      p.balance += share;
      results.push({ id: p.id, name: p.name, got: share, bet: p.bet, correct: true });
    });
    room.currentPot = 0;
  } else {
    players.forEach(p => {
      if (p.bet > 0) {
        results.push({ id: p.id, name: p.name, got: 0, bet: p.bet, correct: false });
      }
    });
  }

  // resolve challenges
  players.forEach(challenger => {
    if (!challenger.challengeTarget) return;
    const target = room.players[challenger.challengeTarget];
    if (!target || target.eliminated) return;
    const amount = Math.min(challenger.challengeAmount, Math.max(0, challenger.balance));
    if (amount <= 0) return;

    if (target.correct) {
      challenger.balance -= amount;
      target.balance += amount;
    } else {
      target.balance -= amount;
      challenger.balance += amount;
    }
  });

  room.lastRoundResults = {
    correctAnswer: room.currentQuestion.answer,
    results,
    allAnswers: players.map(p => ({
      name: p.name,
      answer: p.answer || '—',
      correct: !!p.correct,
      bet: p.bet
    }))
  };

  // check eliminations
  players.forEach(p => {
    if (p.balance <= 0) { p.balance = 0; p.eliminated = true; }
  });

  const remaining = Object.values(room.players).filter(p => !p.eliminated);

  if (remaining.length <= 1) {
    room.winner = remaining[0]?.name || 'لا أحد';
    room.status = 'ended';
    room.phase = 'reveal';
    broadcast(room);
    return;
  }

  room.phase = 'reveal';
  broadcast(room);

  setTimeout(() => {
    if (room.status !== 'playing') return;
    room.round++;
    beginRound(room);
  }, 8000);
}

async function refillQuestions(room) {
  if (room.loading) return;
  room.loading = true;
  try {
    const qs = await generateQuestions(room.categories, room.askedQuestions);
    room.questions.push(...qs);
  } catch (e) {
    console.error('refill failed:', e.message);
  } finally {
    room.loading = false;
  }
}

/* ═══════════════════════════════════════════════════════════════
   🔌 Socket handlers
   ═══════════════════════════════════════════════════════════════ */
io.on('connection', (socket) => {
  socket.on('create-room', ({ name }, cb) => {
    let code;
    do { code = generateCode(); } while (rooms.has(code));

    const room = {
      code,
      hostId: socket.id,
      status: 'lobby',
      players: {},
      categories: [],
      questions: [],
      askedQuestions: [],
      round: 0,
      phase: 'lobby',
      currentQuestion: null,
      currentPot: 0,
      lastRoundResults: null,
      winner: null,
      betTimeLeft: BET_TIME,
      challengeTimeLeft: CHALLENGE_TIME,
      betTimer: null,
      challengeTimer: null,
      loading: false,
      messages: []
    };

    room.players[socket.id] = {
      id: socket.id, name: sanitize(name, 15) || 'لاعب',
      balance: START_BALANCE, eliminated: false,
      bet: 0, answer: '', correct: null,
      challengeTarget: null, challengeAmount: 0,
      betConfirmed: false, isHost: true
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    cb({ ok: true, code, room: publicRoom(room) });
  });

  socket.on('join-room', ({ name, code }, cb) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'الغرفة غير موجودة' });
    if (room.status !== 'lobby') return cb({ ok: false, error: 'اللعبة بدأت بالفعل' });
    if (Object.keys(room.players).length >= 8) return cb({ ok: false, error: 'الغرفة ممتلئة' });

    room.players[socket.id] = {
      id: socket.id, name: sanitize(name, 15) || 'لاعب',
      balance: START_BALANCE, eliminated: false,
      bet: 0, answer: '', correct: null,
      challengeTarget: null, challengeAmount: 0,
      betConfirmed: false, isHost: false
    };

    socket.join(code);
    socket.data.roomCode = code;
    broadcast(room);
    cb({ ok: true, code, room: publicRoom(room) });
  });

  socket.on('start-setup', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (Object.keys(room.players).length < 2) {
      socket.emit('error-msg', 'محتاج لاعبين اتنين على الأقل');
      return;
    }
    room.status = 'setup';
    broadcast(room);
  });

  socket.on('set-categories', ({ categories }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (!Array.isArray(categories) || categories.length < 1) return;
    room.categories = categories.filter(c => CATEGORIES[c]);
    if (room.categories.length < 1) return;
    startGame(room);
  });

  async function startGame(room) {
    room.status = 'playing';
    room.phase = 'loading';
    room.round = 0;
    room.questions = [];
    room.askedQuestions = [];
    room.currentPot = 0;

    Object.values(room.players).forEach(p => {
      p.balance = START_BALANCE;
      p.eliminated = false;
    });

    broadcast(room);

    try {
      const qs = await generateQuestions(room.categories, []);
      room.questions = qs;
      room.round = 1;
      broadcast(room);
      if (qs.length > 0) {
        setTimeout(() => beginRound(room), 800);
      }
    } catch (e) {
      console.error('start failed:', e.message);
      room.status = 'setup';
      io.to(room.hostId).emit('error-msg', 'فشل توليد الأسئلة، حاول تاني');
      broadcast(room);
    }
  }

  socket.on('place-bet', ({ amount }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'betting') return;
    const player = room.players[socket.id];
    if (!player || player.eliminated) return;

    let amt = parseInt(amount, 10);
    if (isNaN(amt) || amt < 0) return;
    if (amt > player.balance) amt = player.balance;
    if (amt > MAX_BET) amt = MAX_BET;

    player.bet = amt;
    broadcast(room);
  });

  socket.on('confirm-bet', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'betting') return;
    const player = room.players[socket.id];
    if (!player || player.eliminated) return;
    player.betConfirmed = true;

    const active = Object.values(room.players).filter(p => !p.eliminated);
    if (active.every(p => p.betConfirmed)) {
      clearBetTimer(room);
      endBettingPhase(room);
    } else {
      broadcast(room);
    }
  });

  socket.on('submit-answer', ({ answer }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'answering') return;
    const player = room.players[socket.id];
    if (!player || player.eliminated) return;
    player.answer = sanitize(answer, 100);
    broadcast(room);

    const active = Object.values(room.players).filter(p => !p.eliminated);
    if (active.every(p => p.answer && p.answer.trim().length > 0)) {
      endAnsweringPhase(room);
    }
  });

  socket.on('force-end-answering', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'answering') return;
    endAnsweringPhase(room);
  });

  socket.on('challenge', ({ targetId, amount }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'challenge') return;
    const player = room.players[socket.id];
    if (!player || player.eliminated) return;

    const target = room.players[targetId];
    if (!target || target.eliminated || targetId === socket.id) return;

    let amt = parseInt(amount, 10);
    if (isNaN(amt) || amt < MIN_BET) return;
    if (amt > player.balance) amt = player.balance;

    player.challengeTarget = targetId;
    player.challengeAmount = amt;
    broadcast(room);
  });

  socket.on('cancel-challenge', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'challenge') return;
    const player = room.players[socket.id];
    if (!player) return;
    player.challengeTarget = null;
    player.challengeAmount = 0;
    broadcast(room);
  });

  socket.on('force-end-challenge', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'challenge') return;
    resolveScoring(room);
  });

  socket.on('chat', ({ text }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    const clean = String(text || '').trim().slice(0, 200);
    if (!clean) return;
    room.messages.push({ name: player.name, text: clean, ts: Date.now() });
    if (room.messages.length > 100) room.messages = room.messages.slice(-100);
    io.to(room.code).emit('chat-msg', room.messages[room.messages.length - 1]);
  });

  socket.on('restart', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    clearBetTimer(room);
    clearChallengeTimer(room);
    room.status = 'lobby';
    room.phase = 'lobby';
    room.round = 0;
    room.currentPot = 0;
    room.currentQuestion = null;
    room.lastRoundResults = null;
    room.winner = null;
    room.questions = [];
    room.askedQuestions = [];
    room.messages = [];
    Object.values(room.players).forEach(p => {
      p.balance = START_BALANCE;
      p.eliminated = false;
      p.bet = 0;
      p.answer = '';
      p.correct = null;
      p.challengeTarget = null;
      p.challengeAmount = 0;
      p.betConfirmed = false;
    });
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    delete room.players[socket.id];

    if (Object.keys(room.players).length === 0) {
      clearBetTimer(room);
      clearChallengeTimer(room);
      rooms.delete(code);
      return;
    }
    if (room.hostId === socket.id) {
      room.hostId = Object.keys(room.players)[0];
    }
    io.to(room.code).emit('room-update', publicRoom(room));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎰 الصندوق شغال على المنفذ ${PORT}`);
});