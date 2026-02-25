from fastapi import FastAPI, File, UploadFile, Form, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
import psycopg2
from psycopg2.extras import RealDictCursor
import os
import csv
import io
import google.generativeai as genai
import json

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

# === НАСТРОЙКА БАЗЫ ДАННЫХ ===
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://neondb_owner:npg_rgLF4vIjyqH1@ep-sparkling-truth-aiwf28f5-pooler.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require")

# === НАСТРОЙКА AI (GEMINI) ===
# Вставь сюда свой бесплатный ключ от Google AI Studio (aistudio.google.com), чтобы ИИ-лаборатория заработала!
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "ТВОЙ_КЛЮЧ_СЮДА") 
if GEMINI_API_KEY and GEMINI_API_KEY != "ТВОЙ_КЛЮЧ_СЮДА":
    genai.configure(api_key=GEMINI_API_KEY)
    ai_model = genai.GenerativeModel('gemini-1.5-flash')
else:
    ai_model = None

def get_db_connection():
    return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)

def init_db():
    conn = get_db_connection()
    cur = conn.cursor()
    # Создаем таблицы, если их нет
    cur.execute("""
        CREATE TABLE IF NOT EXISTS words (
            id SERIAL PRIMARY KEY,
            username TEXT DEFAULT 'default',
            word_type TEXT,
            article TEXT,
            word_de TEXT,
            word_ru TEXT,
            folder TEXT,
            subfolder TEXT,
            score INTEGER DEFAULT 0,
            example TEXT DEFAULT '',
            level TEXT DEFAULT '',
            next_review BIGINT DEFAULT 0,
            plural TEXT DEFAULT '',
            praeteritum TEXT DEFAULT '',
            partizip TEXT DEFAULT '',
            ease_factor REAL DEFAULT 2.5,
            interval INTEGER DEFAULT 0,
            repetitions INTEGER DEFAULT 0
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS study_history (
            username TEXT DEFAULT 'default',
            date_str TEXT,
            ms_spent BIGINT DEFAULT 0,
            PRIMARY KEY (username, date_str)
        )
    """)
    conn.commit()

    # Миграция: добавляем username в старые таблицы, если их там не было
    try: cur.execute("ALTER TABLE words ADD COLUMN username TEXT DEFAULT 'default'")
    except Exception: pass
    try: 
        cur.execute("ALTER TABLE study_history ADD COLUMN username TEXT DEFAULT 'default'")
        cur.execute("ALTER TABLE study_history DROP CONSTRAINT study_history_pkey")
        cur.execute("ALTER TABLE study_history ADD PRIMARY KEY (username, date_str)")
    except Exception: pass
    
    conn.commit()
    cur.close()
    conn.close()

init_db()

# --- МОДЕЛИ ДАННЫХ ---
class WordCreate(BaseModel):
    word_type: str
    article: str = ""
    word_de: str
    plural: str = ""
    word_ru: str
    folder: str
    level: str = ""
    subfolder: str
    example: str = ""
    praeteritum: str = ""
    partizip: str = ""

class ScoreUpdate(BaseModel):
    score: int
    next_review: int = 0
    ease_factor: float = 2.5
    interval: int = 0
    repetitions: int = 0

class FolderReset(BaseModel):
    folder: str
    level: str
    subfolder: str

class FolderRename(BaseModel):
    old_folder: str
    new_folder: str

class SubfolderRename(BaseModel):
    folder: str
    level: str
    old_subfolder: str
    new_subfolder: str

class HistoryUpdate(BaseModel):
    date_str: str
    ms_spent: int

# --- API МАРШРУТЫ (С ПРИВЯЗКОЙ К USERNAME) ---

@app.get("/history")
def get_history(user: str = 'default'):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT date_str, ms_spent FROM study_history WHERE username = %s", (user,))
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return {row['date_str']: row['ms_spent'] for row in rows}

@app.post("/history")
def update_history(data: HistoryUpdate, user: str = 'default'):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO study_history (username, date_str, ms_spent) 
        VALUES (%s, %s, %s) 
        ON CONFLICT (username, date_str) 
        DO UPDATE SET ms_spent = study_history.ms_spent + EXCLUDED.ms_spent
    """, (user, data.date_str, data.ms_spent))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.get("/words")
def get_words(user: str = 'default'):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT * FROM words WHERE username = %s ORDER BY id DESC", (user,))
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return rows

@app.post("/words")
def add_word(word: WordCreate, user: str = 'default'):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        """INSERT INTO words (username, word_type, article, word_de, plural, word_ru, folder, level, subfolder, score, example, next_review, praeteritum, partizip) 
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 0, %s, 0, %s, %s)""", 
        (user, word.word_type, word.article, word.word_de, word.plural, word.word_ru, word.folder, word.level, word.subfolder, word.example, word.praeteritum, word.partizip)
    )
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.put("/words/{word_id}/full")
def edit_word(word_id: int, word: WordCreate, user: str = 'default'):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("""
        UPDATE words SET word_type=%s, article=%s, word_de=%s, plural=%s, word_ru=%s, folder=%s, level=%s, subfolder=%s, example=%s, praeteritum=%s, partizip=%s 
        WHERE id=%s AND username=%s
    """, (word.word_type, word.article, word.word_de, word.plural, word.word_ru, word.folder, word.level, word.subfolder, word.example, word.praeteritum, word.partizip, word_id, user))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.put("/words/rename_folder")
def rename_folder(data: FolderRename, user: str = 'default'):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("UPDATE words SET folder = %s WHERE folder = %s AND username = %s", (data.new_folder, data.old_folder, user))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.put("/words/rename_subfolder")
def rename_subfolder(data: SubfolderRename, user: str = 'default'):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("UPDATE words SET subfolder = %s WHERE folder = %s AND level = %s AND subfolder = %s AND username = %s", 
                (data.new_subfolder, data.folder, data.level, data.old_subfolder, user))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.post("/upload_csv")
async def upload_csv(folder: str = Form(...), level: str = Form(...), subfolder: str = Form(...), user: str = Form('default'), file: UploadFile = File(...)):
    content = await file.read()
    try: text_data = content.decode("utf-8-sig")
    except UnicodeDecodeError: text_data = content.decode("cp1251", errors="replace")
        
    csv_reader = csv.reader(io.StringIO(text_data), delimiter=';')
    words_added = 0
    conn = get_db_connection()
    cur = conn.cursor()
    
    for row in csv_reader:
        if len(row) < 3: continue
        if row[0].lower() == 'word_type': continue 
        while len(row) < 8: row.append("")
            
        w_type = row[0].strip()
        article = row[1].strip()
        word_de = row[2].strip()
        plural = row[3].strip()
        praeteritum = row[4].strip()
        partizip = row[5].strip()
        word_ru = row[6].strip()
        ex = row[7].strip()
        
        cur.execute(
            """INSERT INTO words (username, word_type, article, word_de, plural, word_ru, folder, level, subfolder, score, example, next_review, praeteritum, partizip, ease_factor, interval, repetitions) 
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 0, %s, 0, %s, %s, 2.5, 0, 0)""", 
            (user, w_type, article, word_de, plural, word_ru, folder, level, subfolder, ex, praeteritum, partizip)
        )
        words_added += 1
        
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success", "added": words_added}

@app.put("/words/{word_id}/score")
def update_score(word_id: int, data: ScoreUpdate, user: str = 'default'):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("UPDATE words SET score = %s, next_review = %s, ease_factor = %s, interval = %s, repetitions = %s WHERE id = %s AND username = %s", 
                (data.score, data.next_review, data.ease_factor, data.interval, data.repetitions, word_id, user))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.put("/words/reset_folder")
def reset_folder(data: FolderReset, user: str = 'default'):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("UPDATE words SET score = 0, next_review = 0, ease_factor = 2.5, interval = 0, repetitions = 0 WHERE folder = %s AND level = %s AND subfolder = %s AND username = %s", (data.folder, data.level, data.subfolder, user))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.post("/words/delete_folder")
def delete_folder(data: FolderReset, user: str = 'default'):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("DELETE FROM words WHERE folder = %s AND level = %s AND subfolder = %s AND username = %s", (data.folder, data.level, data.subfolder, user))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.delete("/words/{word_id}")
def delete_word(word_id: int, user: str = 'default'):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("DELETE FROM words WHERE id = %s AND username = %s", (word_id, user))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.get("/export_csv")
def export_csv(user: str = 'default'):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT id, word_type, article, word_de, word_ru, folder, level, subfolder, score, example, next_review, plural, praeteritum, partizip, ease_factor, interval, repetitions FROM words WHERE username = %s", (user,))
    rows = cur.fetchall()
    output = io.StringIO(newline='')
    writer = csv.writer(output, delimiter=';')
    writer.writerow(["id", "word_type", "article", "word_de", "word_ru", "folder", "level", "subfolder", "score", "example", "next_review", "plural", "praeteritum", "partizip", "ease_factor", "interval", "repetitions"])
    for r in rows:
        writer.writerow([r['id'], r['word_type'], r['article'], r['word_de'], r['word_ru'], r['folder'], r['level'], r['subfolder'], r['score'], r['example'], r['next_review'], r['plural'], r['praeteritum'], r['partizip'], r['ease_factor'], r['interval'], r['repetitions']])
    csv_string = '\ufeff' + output.getvalue()
    cur.close()
    conn.close()
    return StreamingResponse(iter([csv_string]), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f"attachment; filename=backup_{user}.csv"})

# === AI ROUTES (ВКЛАДКА ЛАБОРАТОРИЯ) ===
@app.get("/ai/tiny-lesson")
def ai_tiny_lesson(situation: str):
    if not ai_model:
        return {"error": "API ключ Gemini не настроен на сервере. Добавь GEMINI_API_KEY в main.py"}
    
    prompt = f"""
    Действуй как профессиональный преподаватель немецкого языка. Пользователь оказался в ситуации: "{situation}".
    Составь для него микро-урок. Верни СТРОГО JSON-объект в следующем формате (без markdown разметки ```json):
    {{
        "title": "Название ситуации на русском",
        "words": [ {{"de": "слово с артиклем", "ru": "перевод"}} ], // ровно 5 слов
        "phrases": [ {{"de": "фраза", "ru": "перевод"}} ], // ровно 3 полезные фразы
        "grammar_tip": "Короткий и понятный совет по грамматике для этой ситуации (2-3 предложения максимум)"
    }}
    """
    try:
        response = ai_model.generate_content(prompt)
        text = response.text.replace('```json', '').replace('```', '').strip()
        return json.loads(text)
    except Exception as e:
        return {"error": f"Ошибка генерации: {str(e)}"}

@app.get("/ai/slang-hang")
def ai_slang_hang(topic: str):
    if not ai_model:
        return {"error": "API ключ Gemini не настроен на сервере. Добавь GEMINI_API_KEY в main.py"}
    
    prompt = f"""
    Действуй как молодой носитель немецкого языка (зумер/миллениал). Напиши короткий диалог между двумя друзьями на тему: "{topic}".
    ОБЯЗАТЕЛЬНО используй современный немецкий сленг, идиомы или сокращения (например, krass, Digga, läuft, Bock haben и тд).
    Верни СТРОГО JSON-объект в следующем формате (без markdown разметки ```json):
    {{
        "title": "Название диалога",
        "dialogue": [
            {{"speaker": "A", "de": "реплика на немецком", "ru": "живой перевод на русский"}},
            {{"speaker": "B", "de": "реплика на немецком", "ru": "живой перевод на русский"}}
        ], // 4-6 реплик
        "slang_explained": [
            {{"de": "сленговое слово из текста", "ru": "что оно означает"}}
        ]
    }}
    """
    try:
        response = ai_model.generate_content(prompt)
        text = response.text.replace('```json', '').replace('```', '').strip()
        return json.loads(text)
    except Exception as e:
        return {"error": f"Ошибка генерации: {str(e)}"}


@app.get("/")
def serve_html(): return FileResponse("index.html")

@app.get("/{filename}")
def serve_files(filename: str):
    if os.path.exists(filename): return FileResponse(filename)
    return {"status": "ignored"}