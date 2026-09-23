# Regenerates docs/fixtures/*.xlsx (the demo schedule and the blank template).
# python3 tools/make-fixtures.py   — needs openpyxl
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from datetime import date, time, timedelta
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'fixtures')
os.makedirs(OUT, exist_ok=True)

US = 'מכבי גבעתיים'
HOME_VENUE = ('אצטדיון גבעתיים', 'רחוב המעיין 4, גבעתיים')
# Fictional league: 11 opponents, each with its own ground.
OPP = [
  ('בני יהודה', 'מגרש שכונת התקווה', 'רחוב ההגנה 12, תל אביב'),
  ('מכבי יפו', 'מגרש יפו', 'רחוב יפת 150, תל אביב'),
  ('הפועל חולון', 'מגרש קריית שרת', 'רחוב גולדה מאיר 3, חולון'),
  ('בית"ר תל אביב', 'מגרש נווה אליעזר', 'רחוב הגבורה 20, תל אביב'),
  ('מכבי הרצליה', 'מגרש נווה עמל', 'רחוב הבנים 7, הרצליה'),
  ('הפועל בני ברק', 'מגרש חזון איש', 'רחוב ז׳בוטינסקי 60, בני ברק'),
  ('הפועל רמת גן', 'מגרש העירוני רמת גן', 'רחוב ביאליק 90, רמת גן'),
  ('מכבי פתח תקווה', 'מגרש כפר גנים', 'רחוב חיים עוזר 15, פתח תקווה'),
  ('הפועל אור יהודה', 'מגרש העירוני', 'רחוב ההסתדרות 30, אור יהודה'),
  ('עירוני רמת השרון', 'מגרש גרין', 'רחוב סוקולוב 45, רמת השרון'),
  ('מכבי קריית אונו', 'מגרש השבעה', 'רחוב לוי אשכול 10, קריית אונו'),
]
# Rounds 1-5 already played (before 23.9.2026), with scores; the rest ahead.
RESULTS = {1: (3, 1), 2: (1, 1), 3: (0, 2), 4: (2, 0), 5: (4, 2)}
SKIP = {date(2026, 10, 3), date(2026, 10, 10), date(2026, 12, 26), date(2027, 4, 24)}  # holidays / breaks

rows = []
d = date(2026, 8, 22)
for rnd in range(1, 23):
    while d in SKIP:
        d += timedelta(days=7)
    opp = OPP[(rnd - 1) % 11]
    home = (rnd % 2 == 1) if rnd <= 11 else (rnd % 2 == 0)  # second half flips home/away
    t = None if rnd >= 17 else (time(17, 30) if home else (time(18, 0) if rnd % 3 else time(16, 45)))
    venue, addr = HOME_VENUE if home else (opp[1], opp[2])
    h, a = (US, opp[0]) if home else (opp[0], US)
    hg = ag = None
    if rnd in RESULTS:
        us_g, them_g = RESULTS[rnd]
        hg, ag = (us_g, them_g) if home else (them_g, us_g)
    rows.append([rnd, d, t, h, a, venue, addr, hg, ag])
    d += timedelta(days=7)

HEAD = ['מחזור', 'תאריך', 'שעה', 'קבוצת בית', 'קבוצת חוץ', 'מגרש', 'כתובת', 'שערי בית', 'שערי חוץ']
WIDTH = [8, 12, 8, 20, 20, 22, 30, 10, 10]
F = 'Arial'
thin = Side(style='thin', color='D0D5DD')
DARK = PatternFill('solid', fgColor='1F2A44')


def schedule_sheet(ws, data):
    ws.sheet_view.rightToLeft = True
    ws.append(HEAD)
    for c in ws[1]:
        c.font = Font(name=F, bold=True, color='FFFFFF')
        c.fill = DARK
        c.alignment = Alignment(horizontal='center', vertical='center')
    for r in data:
        ws.append(r)
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.font = Font(name=F)
            c.border = Border(bottom=thin)
            c.alignment = Alignment(horizontal='center' if c.column in (1, 2, 3, 8, 9) else 'right')
        row[1].number_format = 'dd/mm/yyyy'
        row[2].number_format = 'hh:mm'
    for i, w in enumerate(WIDTH, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = 'A2'
    ws.row_dimensions[1].height = 22


LEGEND = [
    ('איך לייבא', 'מסך הניהול ← "לוח משחקים" ← "ייבוא לוח מקובץ". או: מסמנים את הטבלה כולל הכותרות, מעתיקים ← "הדבקה מאקסל". אחרי הייבוא לוחצים "שמירה".'),
    ('גיליון', 'האפליקציה קוראת את הגיליון הראשון בלבד. הגיליון הזה (הסבר) לא נקרא.'),
    ('שורה ראשונה', 'חובה: שורת כותרות. לפיה האפליקציה יודעת מה בכל עמודה. סדר העמודות לא משנה, ועמודות נוספות לא מפריעות.'),
    ('', ''),
    ('עמודה', 'מה לכתוב'),
    ('מחזור', 'מספר. לא חובה.'),
    ('תאריך', 'חובה. 26/09/2026 או תא תאריך של אקסל. יום לפני חודש.'),
    ('שעה', 'לא חובה. 17:30. ריק = "שעה טרם נקבעה", ובלי ספירה לאחור.'),
    ('קבוצת בית / קבוצת חוץ', 'שמות שתי הקבוצות, כמו בלוח של ההתאחדות. הקבוצה שלנו מזוהה לבד — זו שמופיעה בכל השורות — ולכן השם שלה צריך להיכתב בכל השורות באותו איות.'),
    ('מגרש, כתובת', 'לא חובה. מהכתובת נבנה קישור ה-Waze.'),
    ('שערי בית / שערי חוץ', 'רק במשחק שכבר נערך. שורה עם שתי תוצאות נכנסת ל"תוצאות משחקים" ולא ללוח. שורה בלי תוצאה = משחק עתידי.'),
    ('', ''),
    ('פורמט חלופי', 'במקום קבוצת בית/חוץ אפשר עמודות "יריבה" ו"בית/חוץ" (בית או חוץ), ובמקום שערי בית/חוץ — "שערים שלנו" ו"שערי היריבה".'),
    ('ייבוא חוזר', 'הלוח מהקובץ מחליף את הלוח הקיים. תוצאות שכבר נמצאות באפליקציה (הוזנו ידנית או נשמרו ממשחק חי) לא נדרסות.'),
    ('המשחק הבא', 'נלקח אוטומטית מהמשחק הקרוב בלוח. התכנסות ותלבושת מוסיפים במסך הניהול, ב"המשחק הבא".'),
]


def legend_sheet(ws, extra=None):
    ws.sheet_view.rightToLeft = True
    for a, b in LEGEND + (extra or []):
        ws.append([a, b])
    for row in ws.iter_rows():
        row[0].font = Font(name=F, bold=True)
        row[1].font = Font(name=F)
        row[0].alignment = Alignment(vertical='top', horizontal='right')
        row[1].alignment = Alignment(wrap_text=True, vertical='top', horizontal='right')
    for c in ws[5]:
        c.font = Font(name=F, bold=True, color='FFFFFF')
        c.fill = DARK
    ws.column_dimensions['A'].width = 24
    ws.column_dimensions['B'].width = 90


wb = Workbook()
ws = wb.active
ws.title = 'לוח משחקים'
schedule_sheet(ws, rows)
legend_sheet(wb.create_sheet('הסבר'), [('', ''), ('הקובץ הזה', 'לוח פיקטיבי לעונת 2026/27: 22 מחזורים, 5 הראשונים עם תוצאות. הקבוצות, המגרשים והכתובות בדויים.')])
wb.save(f'{OUT}/schedule-demo.xlsx')

tpl = Workbook()
ws = tpl.active
ws.title = 'לוח משחקים'
schedule_sheet(ws, [[1, date(2026, 9, 26), time(17, 30), US, 'שם הקבוצה היריבה', HOME_VENUE[0], HOME_VENUE[1], None, None]])
for c in ws[2]:  # the example row is shaded: it is there to be overwritten
    c.fill = PatternFill('solid', fgColor='FFF4CC')
legend_sheet(tpl.create_sheet('הסבר'), [('', ''), ('התבנית', 'השורה הצבועה בצהוב היא דוגמה — מחליפים אותה ומוסיפים שורה לכל משחק.')])
tpl.save(f'{OUT}/schedule-template.xlsx')
print(len(rows), 'rows')
