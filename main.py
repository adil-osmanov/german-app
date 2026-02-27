from fastapi import FastAPI, File, UploadFile, Form, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
import psycopg2
from psycopg2 import pool
from psycopg2.extras import RealDictCursor
import os
import csv
import io

app = FastAPI()
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://neondb_owner:npg_rgLF4vIjyqH1@ep-sparkling-truth-aiwf28f5-pooler.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require")

try:
    connection_pool = pool.SimpleConnectionPool(1, 20, DATABASE_URL, cursor_factory=RealDictCursor)
except Exception as e:
    connection_pool = None

class DBConnection:
    def __init__(self):
        self.conn = connection_pool.getconn() if connection_pool else psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
        self.is_pooled = connection_pool is not None
    def cursor(self, *args, **kwargs):
        return self.conn.cursor(*args, **kwargs)
    def commit(self):
        self.conn.commit()
    def rollback(self):
        self.conn.rollback()
    def close(self):
        if self.is_pooled:
            connection_pool.putconn(self.conn)
        else:
            self.conn.close()

def get_db_connection():
    return DBConnection()

def init_db():
    conn = get_db_connection()
    cur = conn.cursor()
    # Таблица слов
    cur.execute("""
        CREATE TABLE IF NOT EXISTS words (
            id SERIAL PRIMARY KEY,
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
            repetitions INTEGER DEFAULT 0,
            username TEXT DEFAULT 'osman'
        )
    """)
    # Таблица облачной истории изучения
    cur.execute("""
        CREATE TABLE IF NOT EXISTS study_history (
            date_str TEXT,
            ms_spent BIGINT DEFAULT 0,
            username TEXT DEFAULT 'osman',
            PRIMARY KEY (date_str, username)
        )
    """)
    conn.commit()

    # Миграция: добавление username в старые таблицы
    try:
        cur.execute("ALTER TABLE words ADD COLUMN username TEXT DEFAULT 'osman'")
        conn.commit()
    except Exception:
        conn.rollback()
        
    try:
        cur.execute("ALTER TABLE study_history ADD COLUMN username TEXT DEFAULT 'osman'")
        conn.commit()
        # Если колонка добавилась, надо обновить PRIMARY KEY
        cur.execute("ALTER TABLE study_history DROP CONSTRAINT IF EXISTS study_history_pkey CASCADE")
        cur.execute("ALTER TABLE study_history ADD PRIMARY KEY (date_str, username)")
        conn.commit()
    except Exception:
        conn.rollback()

    cur.close()
    conn.close()

init_db()

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

@app.get("/history")
def get_history(x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT date_str, ms_spent FROM study_history WHERE username = %s", (x_user,))
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return {row['date_str']: row['ms_spent'] for row in rows}

@app.post("/history")
def update_history(data: HistoryUpdate, x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO study_history (date_str, ms_spent, username) 
        VALUES (%s, %s, %s) 
        ON CONFLICT (date_str, username) 
        DO UPDATE SET ms_spent = study_history.ms_spent + EXCLUDED.ms_spent
    """, (data.date_str, data.ms_spent, x_user))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.get("/words")
def get_words(x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT * FROM words WHERE username = %s ORDER BY id DESC", (x_user,))
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return rows

@app.post("/words")
def add_word(word: WordCreate, x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO words (word_type, article, word_de, plural, word_ru, folder, level, subfolder, score, example, next_review, praeteritum, partizip, username) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 0, %s, 0, %s, %s, %s)", 
        (word.word_type, word.article, word.word_de, word.plural, word.word_ru, word.folder, word.level, word.subfolder, word.example, word.praeteritum, word.partizip, x_user)
    )
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.put("/words/{word_id}/full")
def edit_word(word_id: int, word: WordCreate, x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("""
        UPDATE words SET word_type=%s, article=%s, word_de=%s, plural=%s, word_ru=%s, folder=%s, level=%s, subfolder=%s, example=%s, praeteritum=%s, partizip=%s WHERE id=%s AND username=%s
    """, (word.word_type, word.article, word.word_de, word.plural, word.word_ru, word.folder, word.level, word.subfolder, word.example, word.praeteritum, word.partizip, word_id, x_user))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.put("/words/rename_folder")
def rename_folder(data: FolderRename, x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("UPDATE words SET folder = %s WHERE folder = %s AND username = %s", (data.new_folder, data.old_folder, x_user))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.put("/words/rename_subfolder")
def rename_subfolder(data: SubfolderRename, x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("UPDATE words SET subfolder = %s WHERE folder = %s AND level = %s AND subfolder = %s AND username = %s", 
                (data.new_subfolder, data.folder, data.level, data.old_subfolder, x_user))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.post("/upload_csv")
def upload_csv(folder: str = Form(...), level: str = Form(...), subfolder: str = Form(...), file: UploadFile = File(...), x_user: str = Header("osman")):
    content = file.file.read()
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
            "INSERT INTO words (word_type, article, word_de, plural, word_ru, folder, level, subfolder, score, example, next_review, praeteritum, partizip, ease_factor, interval, repetitions, username) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 0, %s, 0, %s, %s, 2.5, 0, 0, %s)", 
            (w_type, article, word_de, plural, word_ru, folder, level, subfolder, ex, praeteritum, partizip, x_user)
        )
        words_added += 1
        
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success", "added": words_added}

@app.put("/words/{word_id}/score")
def update_score(word_id: int, data: ScoreUpdate, x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("UPDATE words SET score = %s, next_review = %s, ease_factor = %s, interval = %s, repetitions = %s WHERE id = %s AND username = %s", 
                (data.score, data.next_review, data.ease_factor, data.interval, data.repetitions, word_id, x_user))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.put("/words/reset_folder")
def reset_folder(data: FolderReset, x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("UPDATE words SET score = 0, next_review = 0, ease_factor = 2.5, interval = 0, repetitions = 0 WHERE folder = %s AND level = %s AND subfolder = %s AND username = %s", (data.folder, data.level, data.subfolder, x_user))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.post("/words/delete_folder")
def delete_folder(data: FolderReset, x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("DELETE FROM words WHERE folder = %s AND level = %s AND subfolder = %s AND username = %s", (data.folder, data.level, data.subfolder, x_user))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.delete("/words/{word_id}")
def delete_word(word_id: int, x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("DELETE FROM words WHERE id = %s AND username = %s", (word_id, x_user))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.get("/export_csv")
def export_csv(x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT id, word_type, article, word_de, word_ru, folder, level, subfolder, score, example, next_review, plural, praeteritum, partizip, ease_factor, interval, repetitions FROM words WHERE username = %s", (x_user,))
    rows = cur.fetchall()
    output = io.StringIO(newline='')
    writer = csv.writer(output, delimiter=';')
    writer.writerow(["id", "word_type", "article", "word_de", "word_ru", "folder", "level", "subfolder", "score", "example", "next_review", "plural", "praeteritum", "partizip", "ease_factor", "interval", "repetitions"])
    for r in rows:
        writer.writerow([r['id'], r['word_type'], r['article'], r['word_de'], r['word_ru'], r['folder'], r['level'], r['subfolder'], r['score'], r['example'], r['next_review'], r['plural'], r['praeteritum'], r['partizip'], r['ease_factor'], r['interval'], r['repetitions']])
    csv_string = '\ufeff' + output.getvalue()
    cur.close()
    conn.close()
    return StreamingResponse(iter([csv_string]), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f"attachment; filename=backup_{x_user}.csv"})

@app.post("/restore_backup")
def restore_backup(file: UploadFile = File(...), x_user: str = Header("osman")):
    content = file.file.read()
    try: text_data = content.decode("utf-8-sig")
    except UnicodeDecodeError: text_data = content.decode("cp1251", errors="replace")
    csv_reader = csv.reader(io.StringIO(text_data), delimiter=';')
    next(csv_reader, None) 
    
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("DELETE FROM words WHERE username = %s", (x_user,))
    
    words_added = 0
    for row in csv_reader:
        if len(row) < 10: continue 
        try:
            score = int(row[8]) if row[8] else 0
            next_rev = int(row[10]) if len(row) > 10 and row[10] else 0
            plural_val = row[11] if len(row) > 11 else ""
            praet = row[12] if len(row) > 12 else ""
            part = row[13] if len(row) > 13 else ""
            ease = float(row[14]) if len(row) > 14 and row[14] else 2.5
            interv = int(row[15]) if len(row) > 15 and row[15] else 0
            reps = int(row[16]) if len(row) > 16 and row[16] else 0
            
            cur.execute(
                "INSERT INTO words (word_type, article, word_de, word_ru, folder, level, subfolder, score, example, next_review, plural, praeteritum, partizip, ease_factor, interval, repetitions, username) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)", 
                (row[1], row[2], row[3], row[4], row[5], row[6], row[7], score, row[9], next_rev, plural_val, praet, part, ease, interv, reps, x_user)
            )
            words_added += 1
        except: continue
            
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success", "restored": words_added}

@app.get("/")
def serve_html(): return FileResponse("index.html")

@app.get("/{filename}")
def serve_files(filename: str):
    if os.path.exists(filename): return FileResponse(filename)
    return {"status": "ignored"}