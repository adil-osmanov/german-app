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
import urllib.request
import urllib.parse
import json
import re
import random
import ssl
ssl._create_default_https_context = ssl._create_unverified_context

app = FastAPI()

from fastapi.staticfiles import StaticFiles
import os

if os.path.isdir("images"):
    app.mount("/images", StaticFiles(directory="images"), name="images")
if os.path.isdir("sounds"):
    app.mount("/sounds", StaticFiles(directory="sounds"), name="sounds")

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://neondb_owner:npg_rgLF4vIjyqH1@ep-sparkling-truth-aiwf28f5-pooler.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require")

def get_db_connection():
    return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor, connect_timeout=15)

def fetch_example_sentence(word_de: str) -> str:
    try:
        url = f"https://de.wiktionary.org/w/api.php?action=parse&page={urllib.parse.quote(word_de)}&format=json&prop=wikitext"
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=3) as response:
            data = json.loads(response.read())
            if "parse" in data and "wikitext" in data["parse"]:
                text = data["parse"]["wikitext"]["*"]
                # Найти блок Beispiele
                beispiele_match = re.search(r'{{Beispiele}}\n((?::.+\n?)+)', text)
                if beispiele_match:
                    examples_block = beispiele_match.group(1)
                    # Извлечь все примеры
                    examples_raw = re.findall(r':(?:\[\d+\])?(.+)', examples_block)
                    valid_examples = []
                    for ex in examples_raw:
                        ex = ex.replace("{{", "").replace("}}", "").replace("[[", "").replace("]]", "").strip()
                        ex = re.sub(r'<ref.*?</ref>', '', ex)
                        ex = re.sub(r"''", '', ex).strip()
                        ex = re.sub(r'\{\{[^}]+\}\}', '', ex).strip()
                        if ex.startswith('[') and ']' in ex:
                            ex = ex[ex.find(']')+1:].strip()
                        if ex.startswith('(') and ')' in ex:
                            ex = ex[ex.find(')')+1:].strip()
                        if len(ex) > 5 and len(ex.split()) >= 3:
                            valid_examples.append(ex)
                    
                    if valid_examples:
                        # Сортировать по длине и взять самый короткий
                        valid_examples.sort(key=len)
                        return valid_examples[0]
    except Exception:
        pass
    return ""

@app.get("/tts")
def get_tts(text: str, lang: str = "de"):
    url = f"https://translate.google.com/translate_tts?ie=UTF-8&q={urllib.parse.quote(text)}&tl={lang}&client=tw-ob"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        response = urllib.request.urlopen(req)
        return StreamingResponse(io.BytesIO(response.read()), media_type="audio/mpeg")
    except Exception as e:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=500, content={"error": str(e)})

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
            username TEXT DEFAULT 'osman',
            is_separable BOOLEAN DEFAULT FALSE
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

    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_profiles (
            username TEXT PRIMARY KEY,
            avatar_base64 TEXT
        )
    """)
    conn.commit()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_progress (
            username TEXT PRIMARY KEY,
            level INTEGER DEFAULT 1,
            current_xp BIGINT DEFAULT 0,
            last_action_time TIMESTAMP DEFAULT NOW(),
            rested_words_left INTEGER DEFAULT 0,
            daily_new_words INTEGER DEFAULT 0,
            daily_reviews INTEGER DEFAULT 0,
            last_daily_date TEXT DEFAULT '',
            buff_active BOOLEAN DEFAULT FALSE,
            paragon_completions INTEGER DEFAULT 0
        )
    """)
    conn.commit()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_artifacts (
            id SERIAL PRIMARY KEY,
            username TEXT,
            artifact_name TEXT,
            rarity TEXT,
            dropped_at TIMESTAMP DEFAULT NOW()
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

    try:
        cur.execute("UPDATE words SET level = 'A1' WHERE level = 'а1'")
        conn.commit()
    except Exception:
        conn.rollback()

    try:
        cur.execute("ALTER TABLE words ADD COLUMN target_lang TEXT DEFAULT 'de'")
        conn.commit()
    except Exception:
        conn.rollback()

    try:
        cur.execute("ALTER TABLE user_progress ADD COLUMN paragon_completions INTEGER DEFAULT 0")
        conn.commit()
    except Exception:
        conn.rollback()

    try:
        cur.execute("ALTER TABLE words ADD COLUMN example_ru TEXT DEFAULT ''")
        conn.commit()
    except Exception:
        conn.rollback()

    try:
        cur.execute("ALTER TABLE user_progress ADD COLUMN target_lang TEXT DEFAULT 'de'")
        conn.commit()
        cur.execute("ALTER TABLE user_progress DROP CONSTRAINT IF EXISTS user_progress_pkey CASCADE")
        cur.execute("ALTER TABLE user_progress ADD PRIMARY KEY (username, target_lang)")
        conn.commit()
    except Exception:
        conn.rollback()

    try:
        cur.execute("ALTER TABLE study_history ADD COLUMN target_lang TEXT DEFAULT 'de'")
        conn.commit()
        cur.execute("ALTER TABLE study_history DROP CONSTRAINT IF EXISTS study_history_pkey CASCADE")
        cur.execute("ALTER TABLE study_history ADD PRIMARY KEY (date_str, username, target_lang)")
        conn.commit()
    except Exception:
        conn.rollback()

    try:
        cur.execute("ALTER TABLE user_artifacts ADD COLUMN target_lang TEXT DEFAULT 'de'")
        conn.commit()
    except Exception:
        conn.rollback()

    try:
        cur.execute("ALTER TABLE words ADD COLUMN is_separable BOOLEAN DEFAULT FALSE")
        conn.commit()
    except Exception:
        conn.rollback()

    try:
        cur.execute("ALTER TABLE words ADD COLUMN vt_praet_score INTEGER DEFAULT 0")
        cur.execute("ALTER TABLE words ADD COLUMN vt_praet_next_review BIGINT DEFAULT 0")
        cur.execute("ALTER TABLE words ADD COLUMN vt_praet_ease REAL DEFAULT 2.5")
        cur.execute("ALTER TABLE words ADD COLUMN vt_praet_interval INTEGER DEFAULT 0")
        cur.execute("ALTER TABLE words ADD COLUMN vt_praet_reps INTEGER DEFAULT 0")
        cur.execute("ALTER TABLE words ADD COLUMN vt_part_score INTEGER DEFAULT 0")
        cur.execute("ALTER TABLE words ADD COLUMN vt_part_next_review BIGINT DEFAULT 0")
        cur.execute("ALTER TABLE words ADD COLUMN vt_part_ease REAL DEFAULT 2.5")
        cur.execute("ALTER TABLE words ADD COLUMN vt_part_interval INTEGER DEFAULT 0")
        cur.execute("ALTER TABLE words ADD COLUMN vt_part_reps INTEGER DEFAULT 0")
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
    example_ru: str = ""
    praeteritum: str = ""
    partizip: str = ""
    target_lang: str = "de"

class ScoreUpdate(BaseModel):
    score: int
    next_review: int = 0
    ease_factor: float = 2.5
    interval: int = 0
    repetitions: int = 0
    form_type: str = "base"

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

class CourseDelete(BaseModel):
    folder: str

class LevelDelete(BaseModel):
    folder: str
    level: str

class LevelRename(BaseModel):
    folder: str
    old_level: str
    new_level: str

class HistoryUpdate(BaseModel):
    date_str: str
    ms_spent: int
    target_lang: str = "de"

class AvatarUpdate(BaseModel):
    avatar_base64: str

class ProgressAction(BaseModel):
    action_type: str
    target_lang: str = "de"

def get_user_bonuses(username):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT artifact_name, rarity FROM user_artifacts WHERE username = %s", (username,))
    rows = cur.fetchall()
    cur.close()
    conn.close()
    
    names = set(r['artifact_name'] for r in rows)
    rarities = set(r['rarity'] for r in rows)
    
    bonuses = {
        "xp_multiplier": 1.0,
        "rested_words_cap": 25,
        "unlocked_themes": ["default"]
    }
    
    if {"Загадочная призма", "Искрящийся кристалл", "Темный оникс"}.issubset(names):
        bonuses["xp_multiplier"] += 0.02
        
    if {"Сердце сумрака", "Слеза Сильваны", "Амулет бесконечности"}.issubset(names):
        bonuses["rested_words_cap"] = 30
        
    if "Легендарный" in rarities or "Мифический" in rarities:
        bonuses["unlocked_themes"].append("golden_abyss")
        
    return bonuses

def xp_needed_for_next(lvl):
    return 5 * (lvl ** 2) + 100 * lvl

@app.get("/profiles")
def get_profiles():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT username, avatar_base64 FROM user_profiles")
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return {row['username']: row['avatar_base64'] for row in rows}

@app.post("/profile/avatar")
def update_avatar(data: AvatarUpdate, x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO user_profiles (username, avatar_base64) 
        VALUES (%s, %s) 
        ON CONFLICT (username) 
        DO UPDATE SET avatar_base64 = EXCLUDED.avatar_base64
    """, (x_user, data.avatar_base64))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.get("/history")
def get_history(target_lang: str = "de", x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT date_str, ms_spent FROM study_history WHERE username = %s AND target_lang = %s", (x_user, target_lang))
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return {row['date_str']: row['ms_spent'] for row in rows}

@app.post("/history")
def update_history(data: HistoryUpdate, x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO study_history (date_str, ms_spent, username, target_lang) 
        VALUES (%s, %s, %s, %s) 
        ON CONFLICT (date_str, username, target_lang) 
        DO UPDATE SET ms_spent = study_history.ms_spent + EXCLUDED.ms_spent
    """, (data.date_str, data.ms_spent, x_user, data.target_lang))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.get("/progress")
def get_progress(target_lang: str = "de", x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT * FROM user_progress WHERE username = %s AND target_lang = %s", (x_user, target_lang))
    row = cur.fetchone()
    
    from datetime import datetime, timedelta
    now = datetime.now()
    today_str = now.date().isoformat()
    
    if not row:
        cur.execute("INSERT INTO user_progress (username, level, current_xp, last_action_time, last_daily_date, target_lang) VALUES (%s, 1, 0, NOW(), %s, %s) RETURNING *", (x_user, today_str, target_lang))
        row = cur.fetchone()
        conn.commit()
    
    last_time = row['last_action_time']
    last_daily = row['last_daily_date']
    
    bonuses = get_user_bonuses(x_user)
    
    updates = {}
    if last_time:
        diff = now - last_time
        if diff.total_seconds() > 8 * 3600 and row['rested_words_left'] == 0:
            cap = bonuses["rested_words_cap"]
            updates['rested_words_left'] = cap
            row['rested_words_left'] = cap

    if last_daily != today_str:
        yesterday_str = (now.date() - timedelta(days=1)).isoformat()
        
        # If last_daily is yesterday, check if they closed the ring yesterday.
        if last_daily == yesterday_str:
            yesterday_quest_completed = ((row['daily_new_words'] + row['daily_reviews']) >= 200)
            buff_active = yesterday_quest_completed
            
            if yesterday_quest_completed:
                updates['streak'] = row.get('streak', 0) + 1
            else:
                updates['streak'] = 0
        else:
            buff_active = False
            updates['streak'] = 0
        
        updates['daily_new_words'] = 0
        updates['daily_reviews'] = 0
        updates['last_daily_date'] = today_str
        updates['buff_active'] = buff_active
        updates['paragon_completions'] = 0
        
        row['daily_new_words'] = 0
        row['daily_reviews'] = 0
        row['last_daily_date'] = today_str
        row['buff_active'] = buff_active
        row['paragon_completions'] = 0
        row['streak'] = updates['streak']

    if updates:
        set_clauses = ", ".join([f"{k} = %s" for k in updates.keys()])
        values = list(updates.values()) + [x_user, target_lang]
        cur.execute(f"UPDATE user_progress SET {set_clauses} WHERE username = %s AND target_lang = %s", values)
        conn.commit()

    row['xp_for_next'] = xp_needed_for_next(row['level'])
    row['bonuses'] = bonuses
    
    cur.close()
    conn.close()
    return dict(row)

@app.post("/progress/action")
def progress_action(data: ProgressAction, x_user: str = Header("osman")):
    import math
    import random
    state = get_progress(data.target_lang, x_user)
    
    base_xp = 10 if data.action_type == "new" else 5
    
    rested = False
    if state['rested_words_left'] > 0:
        base_xp = base_xp * 1.5
        rested = True
        
    if state['buff_active']:
        base_xp = base_xp * 1.1
        
    xp_mult = state.get('bonuses', {}).get('xp_multiplier', 1.0)
    base_xp = base_xp * xp_mult
        
    final_xp = math.ceil(base_xp)
    
    new_xp = state['current_xp'] + final_xp
    new_level = state['level']
    leveled_up = False
    
    while new_level < 80:
        needed = xp_needed_for_next(new_level)
        if new_xp >= needed:
            new_xp -= needed
            new_level += 1
            leveled_up = True
        else:
            break
            
    new_daily_new = state['daily_new_words'] + (1 if data.action_type == "new" else 0)
    new_daily_rev = state['daily_reviews'] + (1 if data.action_type == "review" else 0)
    total_actions = new_daily_new + new_daily_rev
    
    quest_just_completed = False
    paragon_completed = False
    new_paragon = state.get('paragon_completions', 0)
    
    if total_actions > 0 and total_actions % 200 == 0:
        if total_actions == 200:
            quest_just_completed = True
            new_xp += 500
        else:
            paragon_completed = True
            new_paragon += 1
            new_xp += 1000
            
        while new_level < 80:
            needed = xp_needed_for_next(new_level)
            if new_xp >= needed:
                new_xp -= needed
                new_level += 1
                leveled_up = True
            else:
                break
                
    # RNG Drop System
    dropped_artifact = None
    if total_actions > 200:
        
        ALL_ARTIFACTS = [            { "name": "Свирепый бурый волк", "rarity": "uncommon", "dropRate": 4.0, "category": "Волки" , "npcId": 38556 },
            { "name": "Вороной скакун", "rarity": "uncommon", "dropRate": 4.0, "category": "Кони" , "npcId": 38556 },
            { "name": "Бурый медведь", "rarity": "uncommon", "dropRate": 4.0, "category": "Медведи" , "npcId": 38556 },
            { "name": "Золотистый грифон", "rarity": "uncommon", "dropRate": 4.0, "category": "Птицы" , "npcId": 38556 },
            { "name": "Зеленый механодолгоног", "rarity": "uncommon", "dropRate": 4.0, "category": "Механизмы" , "npcId": 38556 },
            { "name": "Пятнистый ледопард", "rarity": "uncommon", "dropRate": 4.0, "category": "Кошки" , "npcId": 38556 },
            { "name": "Ледяной мамонт", "rarity": "uncommon", "dropRate": 4.0, "category": "Мамонты" , "npcId": 38556 },
            { "name": "Бронзовый дракон", "rarity": "uncommon", "dropRate": 4.0, "category": "Драконы" , "npcId": 38556 },
            { "name": "Бронированный бурый медведь", "rarity": "rare", "dropRate": 1.0, "category": "Медведи" , "npcId": 38556 },
            { "name": "Стремительный лесной волк", "rarity": "rare", "dropRate": 1.0, "category": "Волки" , "npcId": 38556 },
            { "name": "Стремительный белый скакун", "rarity": "rare", "dropRate": 1.0, "category": "Кони" , "npcId": 38556 },
            { "name": "Шерстистый мамонт", "rarity": "rare", "dropRate": 1.0, "category": "Мамонты" , "npcId": 38556 },
            { "name": "Анжинерский чоппер", "rarity": "rare", "dropRate": 1.0, "category": "Механизмы" , "npcId": 38556 },
            { "name": "Морская черепаха", "rarity": "rare", "dropRate": 1.0, "category": "Уникальные" , "npcId": 38556 },
            { "name": "Синий протодракон", "rarity": "rare", "dropRate": 1.0, "category": "Драконы" , "npcId": 38556 },
            { "name": "Кенарийский боевой гиппогриф", "rarity": "epic", "dropRate": 0.1, "category": "Птицы" , "npcId": 38556 },
            { "name": "Черный боевой волк", "rarity": "epic", "dropRate": 0.1, "category": "Волки" , "npcId": 38556 },
            { "name": "Белый полярный медведь", "rarity": "epic", "dropRate": 0.1, "category": "Медведи" , "npcId": 38556 },
            { "name": "Тундровый мамонт путешественника", "rarity": "epic", "dropRate": 0.1, "category": "Мамонты" , "npcId": 38556 },
            { "name": "Повелитель воронов", "rarity": "epic", "dropRate": 0.1, "category": "Уникальные" , "npcId": 21473 },
            { "name": "Огненный боевой конь", "rarity": "epic", "dropRate": 0.1, "category": "Кони" , "npcId": 38556 },
            { "name": "Поводья дракона Ониксии", "rarity": "epic", "dropRate": 0.1, "category": "Драконы" , "npcId": 38556 },
            { "name": "Черный боевой медведь", "rarity": "legendary", "dropRate": 0.01, "category": "Медведи" , "npcId": 38556 },
            { "name": "Пепел Ал'ара", "rarity": "legendary", "dropRate": 0.01, "category": "Птицы" , "npcId": 18997 },
            { "name": "Затерянный во времени протодракон", "rarity": "legendary", "dropRate": 0.01, "category": "Драконы" , "npcId": 38556 },
            { "name": "Большой черный боевой мамонт", "rarity": "legendary", "dropRate": 0.01, "category": "Мамонты" , "npcId": 38556 },
            { "name": "Голова Мимирона", "rarity": "legendary", "dropRate": 0.01, "category": "Механизмы" , "npcId": 38556 },
            { "name": "Непобедимый", "rarity": "legendary", "dropRate": 0.01, "category": "Кони" , "npcId": 38556, "fullArt": "/images/mounts/Непобедимый.jpeg", "sound": "/sounds/непобедимый.ogg" }
    ]
        # Check independent drops, from rarest to most common
        sorted_mounts = sorted(ALL_ARTIFACTS, key=lambda x: x['dropRate'])
        for mount in sorted_mounts:
            scaled_drop = mount['dropRate'] / 200.0
            roll = random.uniform(0, 100)
            if roll <= scaled_drop:
                artifact_name = mount['name']
                rarity = mount['rarity']
                
                conn = get_db_connection()
                cur = conn.cursor()
                
                # Check for duplicate — each mount is unique in collection
                cur.execute(
                    "SELECT COUNT(*) as cnt FROM user_artifacts WHERE username = %s AND artifact_name = %s AND target_lang = %s",
                    (x_user, artifact_name, data.target_lang)
                )
                already_owned = cur.fetchone()['cnt'] > 0
                
                if already_owned:
                    # Already in collection — skip, no drop
                    cur.close()
                    conn.close()
                    break
                
                cur.execute("""
                    INSERT INTO user_artifacts (username, artifact_name, rarity, target_lang)
                    VALUES (%s, %s, %s, %s) RETURNING id
                """, (x_user, artifact_name, rarity, data.target_lang))
                art_id = cur.fetchone()['id']
                conn.commit()
                cur.close()
                conn.close()
                
                dropped_artifact = {
                    "id": art_id,
                    "name": artifact_name,
                    "rarity": rarity
                }
                break
    
    conn = get_db_connection()
    cur = conn.cursor()
    new_rested_left = max(0, state['rested_words_left'] - 1) if rested else 0
    
    cur.execute("""
        UPDATE user_progress 
        SET level = %s, current_xp = %s, daily_new_words = %s, daily_reviews = %s, 
            rested_words_left = %s, last_action_time = NOW(), paragon_completions = %s
        WHERE username = %s AND target_lang = %s
    """, (new_level, new_xp, new_daily_new, new_daily_rev, new_rested_left, new_paragon, x_user, data.target_lang))
    conn.commit()
    cur.close()
    conn.close()
    
    return {
        "status": "success", 
        "xp_added": final_xp, 
        "leveled_up": leveled_up, 
        "new_level": new_level, 
        "quest_completed": quest_just_completed,
        "paragon_completed": paragon_completed,
        "current_xp": new_xp,
        "xp_for_next": xp_needed_for_next(new_level),
        "artifact": dropped_artifact,
        "daily_actions": total_actions
    }

@app.get("/artifacts")
def get_artifacts(target_lang: str = "de", x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("""
        SELECT id, artifact_name, rarity, dropped_at 
        FROM user_artifacts 
        WHERE username = %s AND target_lang = %s
        ORDER BY dropped_at DESC
    """, (x_user, target_lang))
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return rows


@app.get("/leaderboard")
def get_leaderboard(target_lang: str = "de"):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("""
        SELECT 
            username,
            SUM(score) as total_xp,
            COUNT(*) as all_words,
            SUM(CASE WHEN score >= 4 THEN 1 ELSE 0 END) as learned_words
        FROM words
        WHERE target_lang = %s
        GROUP BY username
    """, (target_lang,))
    word_stats = cur.fetchall()
    
    from datetime import datetime, timedelta
    now = datetime.now()
    monday = (now - timedelta(days=now.weekday())).date()
    monday_str = monday.isoformat()

    cur.execute("""
        SELECT 
            username,
            SUM(ms_spent) as total_ms,
            MAX(date_str) as last_active
        FROM study_history
        WHERE date_str >= %s AND target_lang = %s
        GROUP BY username
    """, (monday_str, target_lang))
    history_stats = cur.fetchall()

    cur.execute("SELECT username, date_str FROM study_history WHERE target_lang = %s ORDER BY username, date_str DESC", (target_lang,))
    all_history = cur.fetchall()
    
    cur.close()
    conn.close()
    
    from collections import defaultdict
    user_history = defaultdict(list)
    for row in all_history:
        user_history[row['username']].append(row['date_str'])
        
    stats_map = {}
    for w in word_stats:
        u = w['username']
        stats_map[u] = dict(w)
        stats_map[u]['total_xp'] = stats_map[u]['total_xp'] or 0
        stats_map[u]['total_ms'] = 0
        stats_map[u]['history'] = list(set(user_history[u]))
        
    for h in history_stats:
        u = h['username']
        if u not in stats_map:
            stats_map[u] = {'username': u, 'total_xp': 0, 'all_words': 0, 'learned_words': 0, 'history': list(set(user_history[u]))}
        stats_map[u]['total_ms'] = h['total_ms']
        
    return list(stats_map.values())

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
    if not word.example and word.word_de:
        example = fetch_example_sentence(word.word_de.strip())
        if example:
            word.example = example

    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO words (word_type, article, word_de, plural, word_ru, folder, level, subfolder, score, example, example_ru, next_review, praeteritum, partizip, target_lang, username) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 0, %s, %s, 0, %s, %s, %s, %s)", 
        (word.word_type, word.article, word.word_de, word.plural, word.word_ru, word.folder, word.level, word.subfolder, word.example, word.example_ru, word.praeteritum, word.partizip, word.target_lang, x_user)
    )
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.put("/words/{word_id}/full")
def edit_word(word_id: int, word: WordCreate, x_user: str = Header("osman")):
    if not word.example and word.word_de:
        example = fetch_example_sentence(word.word_de.strip())
        if example:
            word.example = example

    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("""
        UPDATE words SET word_type = %s, article = %s, word_de = %s, plural = %s, word_ru = %s, folder = %s, level = %s, subfolder = %s, example = %s, example_ru = %s, praeteritum = %s, partizip = %s, target_lang = %s WHERE id = %s AND username = %s
    """, (word.word_type, word.article, word.word_de, word.plural, word.word_ru, word.folder, word.level, word.subfolder, word.example, word.example_ru, word.praeteritum, word.partizip, word.target_lang, word_id, x_user))
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

@app.put("/words/rename_level")
def rename_level(data: LevelRename, x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("UPDATE words SET level = %s WHERE folder = %s AND level = %s AND username = %s", (data.new_level, data.folder, data.old_level, x_user))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.post("/words/delete_course")
def delete_course(data: CourseDelete, x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("DELETE FROM words WHERE folder = %s AND username = %s", (data.folder, x_user))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.post("/words/delete_level")
def delete_level(data: LevelDelete, x_user: str = Header("osman")):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("DELETE FROM words WHERE folder = %s AND level = %s AND username = %s", (data.folder, data.level, x_user))
    conn.commit()
    cur.close()
    conn.close()
    return {"status": "success"}

@app.post("/upload_csv")
def upload_csv(folder: str = Form(...), level: str = Form(...), subfolder: str = Form(...), target_lang: str = Form("de"), file: UploadFile = File(...), x_user: str = Header("osman")):
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
            "INSERT INTO words (word_type, article, word_de, plural, word_ru, folder, level, subfolder, score, example, next_review, praeteritum, partizip, target_lang, ease_factor, interval, repetitions, username) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 0, %s, 0, %s, %s, %s, 2.5, 0, 0, %s)", 
            (w_type, article, word_de, plural, word_ru, folder, level, subfolder, ex, praeteritum, partizip, target_lang, x_user)
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
    
    if data.form_type == "praeteritum":
        cur.execute("UPDATE words SET vt_praet_score = %s, vt_praet_next_review = %s, vt_praet_ease = %s, vt_praet_interval = %s, vt_praet_reps = %s WHERE id = %s AND username = %s", 
                    (data.score, data.next_review, data.ease_factor, data.interval, data.repetitions, word_id, x_user))
    elif data.form_type == "partizip":
        cur.execute("UPDATE words SET vt_part_score = %s, vt_part_next_review = %s, vt_part_ease = %s, vt_part_interval = %s, vt_part_reps = %s WHERE id = %s AND username = %s", 
                    (data.score, data.next_review, data.ease_factor, data.interval, data.repetitions, word_id, x_user))
    else:
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
    cur.execute("SELECT id, word_type, article, word_de, word_ru, folder, level, subfolder, score, example, next_review, plural, praeteritum, partizip, ease_factor, interval, repetitions, vt_praet_score, vt_praet_next_review, vt_praet_ease, vt_praet_interval, vt_praet_reps, vt_part_score, vt_part_next_review, vt_part_ease, vt_part_interval, vt_part_reps FROM words WHERE username = %s", (x_user,))
    rows = cur.fetchall()
    output = io.StringIO(newline='')
    writer = csv.writer(output, delimiter=';')
    writer.writerow(["id", "word_type", "article", "word_de", "word_ru", "folder", "level", "subfolder", "score", "example", "next_review", "plural", "praeteritum", "partizip", "ease_factor", "interval", "repetitions", "vt_praet_score", "vt_praet_next_review", "vt_praet_ease", "vt_praet_interval", "vt_praet_reps", "vt_part_score", "vt_part_next_review", "vt_part_ease", "vt_part_interval", "vt_part_reps"])
    for r in rows:
        writer.writerow([r['id'], r['word_type'], r['article'], r['word_de'], r['word_ru'], r['folder'], r['level'], r['subfolder'], r['score'], r['example'], r['next_review'], r['plural'], r['praeteritum'], r['partizip'], r['ease_factor'], r['interval'], r['repetitions'], r.get('vt_praet_score',0), r.get('vt_praet_next_review',0), r.get('vt_praet_ease',2.5), r.get('vt_praet_interval',0), r.get('vt_praet_reps',0), r.get('vt_part_score',0), r.get('vt_part_next_review',0), r.get('vt_part_ease',2.5), r.get('vt_part_interval',0), r.get('vt_part_reps',0)])
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
def serve_html():
    return FileResponse("index.html", headers={"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache", "Expires": "0"})

@app.get("/{filename}")
def serve_files(filename: str):
    if os.path.exists(filename): return FileResponse(filename)
    return {"status": "ignored"}