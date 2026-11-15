export function isStartFreshConfirmation(text) {
  return typeof text === 'string' && text.trim().replace(/\s+/g, ' ').toUpperCase() === 'START FRESH';
}
