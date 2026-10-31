// Spades Arena — Milestone 1 rules engine (2v2).
//
// Framework-free ES module: runs under Node (for tests) and in the browser
// (for the local table UI) with no dependencies and no DOM access.
// This engine is the single source of truth for legality and scoring in
// Milestone 1. Later milestones put an authoritative server in front of it;
// the engine itself never trusts the caller and validates every action.
//
// Rules implemented: see RULES.md. Summary:
//  - 4 players, 52 cards, no jokers, 13 each, partners opposite (0&2, 1&3).
//  - Spades trump; follow suit; spades cannot be led until broken unless
//    the leader holds only spades.
//  - Nil (bid 0) in 2v2 only: +100 if the bidder takes no tricks, -100 if
//    they take 1+. A nil bidder's tricks still count toward the team total.
//  - Made contract: +10 per bid trick, +1 per overtrick (bag). Set: -10 per
//    bid trick. Every 10 bags costs -100, remainder carries.
//  - Default target 500 (configurable). The hand is always finished before
//    a winner is declared; ties continue with another hand.

export const SUITS = ['S', 'H', 'D', 'C'];
export const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
export const SUIT_COLOR = { S: 'black', H: 'red', D: 'red', C: 'black' };
const RANK_NAME = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

// ---------------------------------------------------------------------------
// Cards
// A card is { r: 2..14, s: 'S'|'H'|'D'|'C' }.

export function cardId(card) {
  const rank = RANK_NAME[card.r] || String(card.r);
  return rank + card.s;
}

export function cardLabel(card) {
  const rank = RANK_NAME[card.r] || String(card.r);
  return rank + SUIT_SYMBOL[card.s];
}

export function parseCard(id) {
  const suit = id.slice(-1);
  const rankPart = id.slice(0, -1);
  const rank =
    rankPart === 'J' ? 11 :
    rankPart === 'Q' ? 12 :
    rankPart === 'K' ? 13 :
    rankPart === 'A' ? 14 : parseInt(rankPart, 10);
  if (!SUITS.includes(suit) || !(rank >= 2 && rank <= 14)) {
    throw new Error(`Invalid card id: ${id}`);
  }
  return { r: rank, s: suit };
}

export function sameCard(a, b) {
  return a.r === b.r && a.s === b.s;
}

export function buildDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (let r = 2; r <= 14; r++) deck.push({ r, s });
  }
  return deck;
}

// ---------------------------------------------------------------------------
// Deterministic randomness (mulberry32). Same seed => same shuffle, so tests
// and bug reports can reproduce any deal exactly.

export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(deck, rng) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

const SUIT_ORDER = { C: 0, D: 1, H: 2, S: 3 };

export function sortHand(hand) {
  return hand.slice().sort((a, b) => {
    if (SUIT_ORDER[a.s] !== SUIT_ORDER[b.s]) return SUIT_ORDER[a.s] - SUIT_ORDER[b.s];
    return b.r - a.r;
  });
}

export function dealHands(rng) {
  const deck = shuffle(buildDeck(), rng);
  const hands = [[], [], [], []];
  for (let i = 0; i < 52; i++) hands[i % 4].push(deck[i]);
  return hands.map(sortHand);
}

// ---------------------------------------------------------------------------
// Trick resolution

// trick: [{ player, card }]. Returns the winning player index.
export function trickWinner(trick) {
  const ledSuit = trick[0].card.s;
  let best = trick[0];
  for (const play of trick.slice(1)) {
    const c = play.card;
    const b = best.card;
    if (c.s === 'S' && b.s !== 'S') {
      best = play; // trump beats non-trump
    } else if (c.s === b.s && c.r > b.r) {
      best = play; // higher card of the same suit
    }
    // Otherwise the current best stands (including a lower trump vs a
    // higher trump, and any off-suit non-trump card).
  }
  // Led-suit check: a non-trump card only wins if it matches the led suit
  // and beats the current best's rank. The loop above already enforces this
  // because a card wins only when its suit equals the best card's suit or
  // it is trump over non-trump. One correction: if best is a trump and the
  // challenger is led-suit, the challenger must not win — handled, since
  // c.s !== b.s and c.s !== 'S' falls through. If best is led-suit and the
  // challenger is an off-suit non-trump, c.s !== b.s, so no win. Correct.
  return best.player;
}

// ---------------------------------------------------------------------------
// Legality

// hand: cards the player currently holds.
// trick: plays so far this trick (empty when leading).
// spadesBroken: boolean.
// Returns the subset of hand that may legally be played.
export function legalPlays(hand, trick, spadesBroken) {
  if (trick.length === 0) {
    const nonSpades = hand.filter((c) => c.s !== 'S');
    // Cannot lead spades until broken, unless holding only spades.
    if (!spadesBroken && nonSpades.length > 0) return nonSpades;
    return hand.slice();
  }
  const ledSuit = trick[0].card.s;
  const following = hand.filter((c) => c.s === ledSuit);
  if (following.length > 0) return following;
  return hand.slice(); // void in led suit: any card
}

export function teamOf(player) {
  return player % 2; // 0&2 => team 0, 1&3 => team 1
}

export function partnerOf(player) {
  return (player + 2) % 4;
}

// ---------------------------------------------------------------------------
// Game state

export function createGame({ seed = 1, target = 500, handLimit = 0 } = {}) {
  const game = {
    seed,
    target,
    handLimit, // 0 = no limit; lobby pick (5/10/15/20) ends the match after that many hands
    rng: makeRng(seed),
    handNumber: 0,
    dealer: 0,
    phase: 'bidding', // 'bidding' | 'playing' | 'gameOver'
    turn: 1, // first bidder sits left of the dealer (dealer 0)
    leader: 1,
    hands: [[], [], [], []],
    bids: [null, null, null, null],
    trick: [], // [{ player, card }]
    lastTrick: null, // { plays, winner }
    tricksWon: [0, 0], // per team, this hand
    playerTricks: [0, 0, 0, 0], // per player, this hand
    trickCount: 0,
    spadesBroken: false,
    scores: [0, 0],
    bags: [0, 0],
    winner: null,
    lastScoredHand: 0, // handNumber of the last hand scored; guards retried scoring
    log: [], // public events only: bids, plays, trick winners, hand scores
  };
  startHand(game);
  return game;
}

function startHand(game) {
  game.handNumber += 1;
  game.hands = dealHands(game.rng);
  game.bids = [null, null, null, null];
  game.trick = [];
  game.lastTrick = null;
  game.tricksWon = [0, 0];
  game.playerTricks = [0, 0, 0, 0];
  game.trickCount = 0;
  game.spadesBroken = false;
  game.leader = (game.dealer + 1) % 4;
  game.turn = game.leader;
  game.phase = 'bidding';
  game.log.push({ type: 'handStart', hand: game.handNumber, dealer: game.dealer });
}

export function placeBid(game, player, bid) {
  if (game.phase !== 'bidding') throw new Error('Bidding is not open.');
  if (player !== game.turn) throw new Error(`Not player ${player}'s turn to bid.`);
  if (!Number.isInteger(bid) || bid < 0 || bid > 13) {
    throw new Error('Bid must be an integer from 0 to 13.');
  }
  game.bids[player] = bid;
  game.log.push({ type: 'bid', player, bid });
  game.turn = (game.turn + 1) % 4;
  if (game.bids.every((b) => b !== null)) {
    game.phase = 'playing';
    game.turn = game.leader;
  }
  return game;
}

export function playCard(game, player, card) {
  if (game.phase !== 'playing') throw new Error('No trick in progress.');
  if (player !== game.turn) throw new Error(`Not player ${player}'s turn.`);
  const hand = game.hands[player];
  const idx = hand.findIndex((c) => sameCard(c, card));
  if (idx === -1) throw new Error(`Player ${player} does not hold ${cardId(card)}.`);
  const legal = legalPlays(hand, game.trick, game.spadesBroken);
  if (!legal.some((c) => sameCard(c, card))) {
    throw new Error(`Illegal play: ${cardId(card)} is not a legal play here.`);
  }
  hand.splice(idx, 1);
  game.trick.push({ player, card });
  // Strict breaking: only a spade played on a NON-spade-led trick breaks.
  // A lead never breaks (trick[0] is the card just played), and followers
  // on a spades-led trick do not break either.
  if (card.s === 'S' && game.trick[0].card.s !== 'S') game.spadesBroken = true;
  game.log.push({ type: 'play', player, card: cardId(card) });

  if (game.trick.length === 4) {
    const winner = trickWinner(game.trick);
    const team = teamOf(winner);
    game.tricksWon[team] += 1;
    game.playerTricks[winner] += 1;
    game.trickCount += 1;
    game.lastTrick = { plays: game.trick, winner };
    game.log.push({ type: 'trick', winner, trick: game.trickCount });
    game.trick = [];
    game.leader = winner;
    game.turn = winner;
    if (game.trickCount === 13) {
      scoreHand(game);
    }
  } else {
    game.turn = (game.turn + 1) % 4;
  }
  return game;
}

export function scoreHand(game) {
  // Idempotency guard: a retried scoring call for the same hand must be a
  // no-op, never a double-apply. Keyed by handNumber (not a boolean) so the
  // next hand always scores normally. A future server layer must ALSO dedupe
  // by (match, hand, action id) — this guard is the engine-side backstop.
  if (game.lastScoredHand === game.handNumber) return;
  const handScores = [0, 0];
  const handBags = [0, 0];
  for (let t = 0; t < 2; t++) {
    const p = t === 0 ? 0 : 1;
    const q = partnerOf(p);
    const bid = game.bids[p] + game.bids[q];
    const tricks = game.tricksWon[t];
    if (tricks >= bid) {
      const over = tricks - bid;
      handScores[t] += bid * 10 + over;
      handBags[t] += over;
    } else {
      handScores[t] += -bid * 10;
    }
  }
  // Nil results, applied on top of the contract result.
  for (let p = 0; p < 4; p++) {
    if (game.bids[p] === 0) {
      handScores[teamOf(p)] += game.playerTricks[p] === 0 ? 100 : -100;
    }
  }
  // Bag penalty: every 10 bags costs 100, remainder carries.
  for (let t = 0; t < 2; t++) {
    game.bags[t] += handBags[t];
    const penalty = Math.floor(game.bags[t] / 10) * 100;
    if (penalty > 0) {
      game.bags[t] %= 10;
      handScores[t] -= penalty;
    }
    game.scores[t] += handScores[t];
  }
  game.lastScoredHand = game.handNumber;
  game.log.push({
    type: 'handScore',
    hand: game.handNumber,
    bids: game.bids.slice(),
    tricks: game.tricksWon.slice(),
    handScores,
    scores: game.scores.slice(),
    bags: game.bags.slice(),
  });

  const [s0, s1] = game.scores;
  const limitReached = game.handLimit > 0 && game.handNumber >= game.handLimit;
  if (s0 >= game.target || s1 >= game.target || limitReached) {
    if (s0 !== s1) {
      game.winner = s0 > s1 ? 0 : 1;
      game.phase = 'gameOver';
      game.log.push({ type: 'gameOver', winner: game.winner, scores: game.scores.slice() });
      return;
    }
    // Tie at target or at the hand limit: play another hand.
  }
  game.dealer = (game.dealer + 1) % 4;
  startHand(game);
}

// ---------------------------------------------------------------------------
// Simple heuristic bots (Milestone 1 only). Clearly labeled BOT in the UI.
// They play legally and sensibly; they are not strategic opponents.

export function bidBot(hand) {
  let bid = 0;
  for (const suit of SUITS) {
    const cards = hand.filter((c) => c.s === suit).map((c) => c.r);
    const len = cards.length;
    if (cards.includes(14)) bid += 1; // ace
    if (cards.includes(13) && len >= 2) bid += 1; // king with support
    if (cards.includes(12) && len >= 3) bid += 1; // queen with support
  }
  const spades = hand.filter((c) => c.s === 'S').length;
  if (spades >= 5) bid += 1; // long trump suit
  // Bots never bid nil in Milestone 1.
  return Math.max(1, Math.min(13, bid));
}

export function playBot(game, player) {
  const hand = game.hands[player];
  const legal = legalPlays(hand, game.trick, game.spadesBroken);
  const lowest = (cards) => cards.slice().sort((a, b) => a.r - b.r)[0];

  if (game.trick.length === 0) {
    // Lead: lowest card of the longest non-spade suit; only spades if forced.
    const nonSpades = legal.filter((c) => c.s !== 'S');
    if (nonSpades.length > 0) {
      let bestSuit = null;
      let bestLen = -1;
      for (const suit of SUITS) {
        if (suit === 'S') continue;
        const len = nonSpades.filter((c) => c.s === suit).length;
        if (len > bestLen) {
          bestLen = len;
          bestSuit = suit;
        }
      }
      return lowest(nonSpades.filter((c) => c.s === bestSuit));
    }
    return lowest(legal);
  }

  const ledSuit = game.trick[0].card.s;
  const following = legal.filter((c) => c.s === ledSuit);
  if (following.length > 0) {
    // Try to win with the lowest winning card; otherwise shed the lowest.
    const current = trickWinner(game.trick);
    const currentCard = game.trick.find((p) => p.player === current).card;
    const winners = following.filter((c) => {
      if (ledSuit === 'S') return c.r > currentCard.r;
      // Current winner is trump or led suit; a led-suit card can only win
      // if the current winner is also led-suit and lower.
      if (currentCard.s === 'S') return false;
      return c.r > currentCard.r;
    });
    if (winners.length > 0) return lowest(winners);
    return lowest(following);
  }

  // Void in led suit.
  const spadeOnTrick = game.trick.some((p) => p.card.s === 'S');
  if (!spadeOnTrick) {
    const spades = legal.filter((c) => c.s === 'S');
    if (spades.length > 0) return lowest(spades); // cut with the lowest spade
  }
  // Discard: lowest card, preferring not to throw away an ace or a spade.
  const safe = legal.filter((c) => c.s !== 'S' && c.r !== 14);
  if (safe.length > 0) return lowest(safe);
  return lowest(legal);
}

// Drive a whole match with all-bot players. Used by tests (and available to
// any future simulation tooling). Returns the finished game.
export function playOutWithBots(game) {
  let guard = 0;
  while (game.phase !== 'gameOver') {
    if (game.phase === 'bidding') {
      placeBid(game, game.turn, bidBot(game.hands[game.turn]));
    } else {
      playCard(game, game.turn, playBot(game, game.turn));
    }
    if (++guard > 100000) throw new Error('Bot match did not terminate.');
  }
  return game;
}
