from fastapi import FastAPI, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
import psycopg2
from psycopg2.extras import RealDictCursor
import os
import csv
import io

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://neondb_owner:npg_rgLF4vIjyqH1@ep-sparkling-truth-aiwf28f5-pooler.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require")

def get_db_connection():
    return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)

def init_db():
    conn = get_db_connection()
    cur = conn.cursor()
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
            plural TEXT DEFAULT ''
        )
    """)
    conn.commit()
    
    try:
        cur.execute("ALTER TABLE words ADD COLUMN praeteritum TEXT DEFAULT ''")
        conn.commit()
    except Exception:
        conn.rollback()
        
    try:
        cur.execute("ALTER TABLE words ADD COLUMN partizip TEXT DEFAULT ''")
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

class FolderReset(BaseModel):
    folder: str
    level: str
    subfolder: str

@app.get("/words")
def get_words():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT * FROM words ORDER BY id DESC")
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return rows

@app.post("/words")
def add_word(word: WordCreate):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO words (word_type, article, word_de, plural, word_ru, folder, level, subfolder, score, example, next_review, praeteritum, partizip) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 0, %s, 0, %s, %s)", 
        (word.word_type, word.article, word.word_de, word.plural, word.word_ru, word.folder, word.level, word.subfolder, word.example, word.praeteritum, word.partizip)
    )
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.put("/words/{word_id}/full")
def edit_word(word_id: int, word: WordCreate):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("""
        UPDATE words SET word_type=%s, article=%s, word_de=%s, plural=%s, word_ru=%s, folder=%s, level=%s, subfolder=%s, example=%s, praeteritum=%s, partizip=%s WHERE id=%s
    """, (word.word_type, word.article, word.word_de, word.plural, word.word_ru, word.folder, word.level, word.subfolder, word.example, word.praeteritum, word.partizip, word_id))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.post("/upload_csv")
async def upload_csv(folder: str = Form(...), level: str = Form(...), subfolder: str = Form(...), file: UploadFile = File(...)):
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
        
        # Защита от пустых колонок в конце
        while len(row) < 8:
            row.append("")
            
        w_type = row[0].strip()
        article = row[1].strip()
        word_de = row[2].strip()
        plural = row[3].strip()
        praeteritum = row[4].strip()
        partizip = row[5].strip()
        word_ru = row[6].strip()
        ex = row[7].strip()
        
        cur.execute(
            "INSERT INTO words (word_type, article, word_de, plural, word_ru, folder, level, subfolder, score, example, next_review, praeteritum, partizip) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 0, %s, 0, %s, %s)", 
            (w_type, article, word_de, plural, word_ru, folder, level, subfolder, ex, praeteritum, partizip)
        )
        words_added += 1
        
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success", "added": words_added}

@app.post("/restore_backup")
async def restore_backup(file: UploadFile = File(...)):
    content = await file.read()
    try: text_data = content.decode("utf-8-sig")
    except UnicodeDecodeError: text_data = content.decode("cp1251", errors="replace")
    csv_reader = csv.reader(io.StringIO(text_data), delimiter=';')
    next(csv_reader, None) 
    
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("DELETE FROM words")
    
    words_added = 0
    for row in csv_reader:
        if len(row) < 10: continue 
        try:
            score = int(row[8]) if row[8] else 0
            next_rev = int(row[10]) if len(row) > 10 and row[10] else 0
            plural_val = row[11] if len(row) > 11 else ""
            praet = row[12] if len(row) > 12 else ""
            part = row[13] if len(row) > 13 else ""
            cur.execute(
                "INSERT INTO words (word_type, article, word_de, word_ru, folder, level, subfolder, score, example, next_review, plural, praeteritum, partizip) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)", 
                (row[1], row[2], row[3], row[4], row[5], row[6], row[7], score, row[9], next_rev, plural_val, praet, part)
            )
            words_added += 1
        except: continue
            
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success", "restored": words_added}

@app.put("/words/{word_id}/score")
def update_score(word_id: int, data: ScoreUpdate):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("UPDATE words SET score = %s, next_review = %s WHERE id = %s", (data.score, data.next_review, word_id))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.put("/words/reset_folder")
def reset_folder(data: FolderReset):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("UPDATE words SET score = 0, next_review = 0 WHERE folder = %s AND level = %s AND subfolder = %s", (data.folder, data.level, data.subfolder))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.post("/words/delete_folder")
def delete_folder(data: FolderReset):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("DELETE FROM words WHERE folder = %s AND level = %s AND subfolder = %s", (data.folder, data.level, data.subfolder))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.delete("/words/{word_id}")
def delete_word(word_id: int):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("DELETE FROM words WHERE id = %s", (word_id,))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.get("/export_csv")
def export_csv():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT id, word_type, article, word_de, word_ru, folder, level, subfolder, score, example, next_review, plural, praeteritum, partizip FROM words")
    rows = cur.fetchall()
    output = io.StringIO(newline='')
    writer = csv.writer(output, delimiter=';')
    writer.writerow(["id", "word_type", "article", "word_de", "word_ru", "folder", "level", "subfolder", "score", "example", "next_review", "plural", "praeteritum", "partizip"])
    for r in rows:
        writer.writerow([r['id'], r['word_type'], r['article'], r['word_de'], r['word_ru'], r['folder'], r['level'], r['subfolder'], r['score'], r['example'], r['next_review'], r['plural'], r['praeteritum'], r['partizip']])
    csv_string = '\ufeff' + output.getvalue()
    cur.close()
    conn.close()
    return StreamingResponse(iter([csv_string]), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": "attachment; filename=backup.csv"})

@app.get("/")
def serve_html(): return FileResponse("index.html")

@app.get("/{filename}")
def serve_files(filename: str):
    if os.path.exists(filename): return FileResponse(filename)
    return {"status": "ignored"}