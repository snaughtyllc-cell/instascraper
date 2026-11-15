import { isStartFreshConfirmation } from './startFreshConfirmation';

test.each([
  ['START FRESH', true],
  ['start fresh', true],
  ['  Start   Fresh ', true],
  [null, false],
  ['', false],
  ['START', false],
])('isStartFreshConfirmation(%p) returns %p', (text, expected) => {
  expect(isStartFreshConfirmation(text)).toBe(expected);
});
