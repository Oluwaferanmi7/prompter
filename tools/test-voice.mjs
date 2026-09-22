// Unit test for the voice-glide matcher (no browser needed): node tools/test-voice.mjs
import { createVoice, indexScript } from '../app/js/voice.js';

const script = `Hey everyone, welcome to 42 Maple Street.

This four bedroom home just hit the market and it will not last long.

Let me show you around the kitchen first, because honestly it is the heart of this house.

Then we'll head upstairs to the primary suite.`;

const idx = indexScript(script);
let moves = [];
const v = createVoice({ onMove: (a) => moves.push(a) });
v.setScript(script);
v.setCursorNear({ p: 0, f: 0 });

let fails = 0;
function check(name, cond, extra = '') {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
  if (!cond) fails++;
}
const wordAt = (i) => idx[i]?.w;

// 1. reading the first sentence verbatim
v.feed(['hey', 'everyone', 'welcome', 'to', '42']);
check('follows verbatim reading', v.cursor === 4, `cursor=${v.cursor} (${wordAt(v.cursor)})`);
check('moves to the next word', moves.at(-1)?.p === 0 && moves.length === 1);

// 2. ad-libbed words in the middle: "maple street, uh, you guys, this four bedroom home"
v.feed(['maple', 'street', 'uh', 'you', 'guys']);
const c2 = v.cursor;
check('ignores ad-lib after "street"', c2 === 6, `cursor=${c2} (${wordAt(c2)})`);
v.feed(['this', 'four', 'bedroom', 'home']);
check('picks up again after ad-lib', wordAt(v.cursor) === 'home', `cursor=${v.cursor} (${wordAt(v.cursor)})`);

// 3. dropped a script word ("just hit the market" → "hit the market")
v.feed(['hit', 'the', 'market']);
check('tolerates a dropped word', wordAt(v.cursor) === 'market', `(${wordAt(v.cursor)})`);

// 4. fully off script for a while: cursor must hold
const before = v.cursor;
v.feed(['so', 'anyway', 'my', 'dog', 'ran', 'off', 'yesterday', 'and', 'the', 'weather']);
check('holds while off script', v.cursor === before, `cursor=${v.cursor} (${wordAt(v.cursor)})`);

// 5. comes back mid-sentence
v.feed(['it', 'will', 'not', 'last', 'long']);
check('re-acquires when back on script', wordAt(v.cursor) === 'long', `(${wordAt(v.cursor)})`);

// 6. swapped word ("show you around the kitchen" → "show you round the kitchen")
v.feed(['let', 'me', 'show', 'you', 'round', 'the', 'kitchen']);
check('tolerates a swapped word', wordAt(v.cursor) === 'kitchen', `(${wordAt(v.cursor)})`);

// 7. speech-recognition fuzz ("honestly" → "honesty", "heart" → "hard")
v.feed(['first', 'because', 'honesty', 'it', 'is', 'the', 'hard']);
check('tolerates recognition slips', ['the', 'heart', 'of'].includes(wordAt(v.cursor)), `(${wordAt(v.cursor)})`);

// 8. skips a whole paragraph ahead: needs strong evidence, then jumps
v.feed(['then', 'well', 'head', 'upstairs', 'to', 'the', 'primary']);
check('jumps ahead on strong evidence', idx[v.cursor]?.p === 6, `p=${idx[v.cursor]?.p} (${wordAt(v.cursor)})`);

// 9. retake: reader goes back to the start of the paragraph
v.setCursorNear({ p: 6, f: 0 });
v.feed(['then', 'well', 'head', 'upstairs']);
check('retake from paragraph start', wordAt(v.cursor) === 'upstairs', `(${wordAt(v.cursor)})`);

console.log(fails ? `\n${fails} failing` : '\nall good');
process.exit(fails ? 1 : 0);
