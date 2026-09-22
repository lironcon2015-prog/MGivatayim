#!/bin/bash
# Session start: declare the always-on skill, and in a remote session make
# the test suites runnable (playwright; the browser is already in the image).
set -euo pipefail

# ── סקיל שנטען בכל סשן ─────────────────────────────────────────────────────
# סקיל נטען כשמפעילים אותו או כשהתיאור שלו מתאים לשיחה, ולכן "תמיד פעיל"
# אינו תכונה שלו — הוא נאמר כאן. הפלט של SessionStart נכנס להקשר הסשן.
# **מעל** הבדיקה המרוחקת בכוונה: זה חל גם על סשן מקומי.
cat <<'ACTIVATE'
פעיל בסשן הזה: .claude/skills/token-efficient-workflow/SKILL.md — קרא אותו עכשיו
ועבוד לפיו לאורך כל הסשן, בלי קשר לסוג המשימה. תמצית: חיפוש ממוקד לפני קריאה,
קריאת טווחים ולא קבצים שלמים, עריכה כירורגית ולא כתיבה מחדש, ואפס מילות קישור.
גובר עליו רק CLAUDE.md — ובפרט: ארבע הסוויטות רצות לפני דחיפה ל-main, התיעוד
מתעדכן, והתקשורת עם בעל הריפו בעברית עם סיכום קצר בסוף.
ACTIVATE

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
