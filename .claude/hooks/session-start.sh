#!/bin/bash
# Session start: declare the always-on skill, and in a remote session make
# the test suites runnable (playwright; the browser is already in the image).
set -euo pipefail

# ── סקיל שנטען בכל סשן ─────────────────────────────────────────────────────
# סקיל נטען כשמפעילים אותו או כשהתיאור שלו מתאים לשיחה, ולכן "תמיד פעיל"
# אינו תכונה שלו — הוא נאמר כאן. הפלט של SessionStart נכנס להקשר הסשן.
# **מעל** הבדיקה המרוחקת בכוונה: זה חל גם על סשן מקומי.
# הכללים עצמם נכנסים להקשר, לא רק הפניה לקובץ: "קרא אותו" לבדו פוספס בסשן
# שלם (הסוכן לא קרא). בלי ה-frontmatter, שהוא בשביל טעינת הסקיל ולא בשבילנו.
SKILL="$(dirname "$0")/../skills/token-efficient-workflow/SKILL.md"
echo "פעיל בכל סשן, בלי קשר לסוג המשימה — הכללים המלאים (מ-.claude/skills/token-efficient-workflow/SKILL.md):"
echo
awk 'BEGIN{n=0} /^---$/ && n<2 {n++; next} n>=2' "$SKILL"

# מקומית לא נוגעים בכלום — שם הסביבה של המפתח היא הסמכות.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# הבדיקות מריצות את ה-Chromium שבתמונה (/opt/pw-browsers) ישירות, ולכן כל
# גרסת playwright מספיקה; מתקינים רק אם חסר. node_modules מוחרג ב-.gitignore.
if [ ! -f node_modules/playwright/package.json ]; then
  echo "מתקין playwright"
  npm install --no-audit --no-fund --no-save --silent playwright || echo "אזהרה: התקנת playwright נכשלה"
else
  echo "playwright כבר מותקן"
fi
