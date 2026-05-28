// Tiny i18n helper. Two ways to use:
//   1. Mark up HTML with data-i18n="messageKey" → applyI18n() fills textContent.
//      Use data-i18n-attr="title:messageKey,placeholder:otherKey" for attributes.
//   2. Call t('key', [subs]) to get a translated string for inline use.
// Chrome's chrome.i18n.getMessage picks the right locale automatically based
// on the user's browser language, with default_locale as fallback.

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

function applyI18n(root) {
  root = root || document;
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    const spec = el.getAttribute('data-i18n-attr');
    spec.split(',').forEach((pair) => {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });
}
