
        const t = (str) => {
            const lang = typeof currentLang !== 'undefined' ? currentLang : (localStorage.getItem('uiLang') || 'ru');
            if (lang === 'ru') return str;
            if (window.i18nDict && window.i18nDict[str] && window.i18nDict[str][lang]) return window.i18nDict[str][lang];
            return str;
        };
        const escapeStr = (str) => (str || '').replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, "&quot;");

        // --- PREMIUM UX UTILS ---
        let _audioCtx = null;
        const playSound = (type) => {
            try {
                if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                if (_audioCtx.state === 'suspended') _audioCtx.resume();

                const ctx = _audioCtx;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);

                if (type === 'success') {
                    osc.type = 'triangle';
                    osc.frequency.setValueAtTime(400, ctx.currentTime);
                    osc.frequency.exponentialRampToValueAtTime(800, ctx.currentTime + 0.1);
                    gain.gain.setValueAtTime(0.1, ctx.currentTime);
                    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
                    osc.start();
                    osc.stop(ctx.currentTime + 0.2);
                }
            } catch (e) { }
        };

        const triggerVibration = (pattern) => {
            if (navigator.vibrate) navigator.vibrate(pattern);
        };

        const attachMagneticEffect = (el) => {
            if (!el) return;
            el.addEventListener('mousemove', (e) => {
                const rect = el.getBoundingClientRect();
                const x = e.clientX - rect.left - rect.width / 2;
                const y = e.clientY - rect.top - rect.height / 2;
                el.style.transform = `translate(${x * 0.3}px, ${y * 0.3}px) scale(1.1)`;
            });
            el.addEventListener('mouseleave', () => {
                el.style.transform = `translate(0px, 0px) scale(1)`;
            });
        };

        let lastGlowTime = 0;
        document.addEventListener('mousemove', (e) => {
            const glow = document.getElementById('cursor-glow');
            if (!glow) return;
            const now = Date.now();
            if (now - lastGlowTime > 16) {
                requestAnimationFrame(() => {
                    glow.style.background = `radial-gradient(800px circle at ${e.clientX}px ${e.clientY}px, #ffffff, transparent 50%)`;
                });
                lastGlowTime = now;
            }
        });
        // -----------------------


        // Утилита очистки немецкого предложения от русского перевода
        const extractGermanSentence = (ex) => {
            if (!ex) return "";
            return ex.split(/[-—(/\[]/)[0].trim().replace(/[.,?!]/g, '');
        };

        const API_URL = '/words';
        let currentType = 'noun';
        let editId = null;
        let globalWords = [];
        let serverHistory = {};

        let sessionStartMs = 0;
        const DAILY_GOAL_MINUTES = 15;
        const MAX_SCORE = 4;
        let currentStudyLang = localStorage.getItem('studyLanguage') || 'de';

        window.setStudyLanguage = async (lang, skipFetch) => {
            currentStudyLang = lang;
            localStorage.setItem('studyLanguage', lang);
            updateProfileUI();

            if (typeof setupAddWordModal === 'function') setupAddWordModal();

            if (!skipFetch) {
                globalWords = [];
                if (!document.getElementById('view-dict').classList.contains('hidden')) {
                    await fetchWords();
                    renderDict();
                } else {
                    await switchView(Object.keys(views).find(k => !views[k].classList.contains('hidden')) || 'dict');
                }
            }
        };

        const setupAddWordModal = () => {
            const artSel = document.getElementById('article-selector');
            if (artSel) artSel.style.display = currentStudyLang === 'de' && currentType === 'noun' ? 'flex' : 'none';
            const plInp = document.getElementById('plural-input-group');
            if (plInp) plInp.style.display = currentStudyLang === 'de' && currentType === 'noun' ? 'flex' : 'none';
            const verbGrp = document.getElementById('verb-forms-group');
            if (verbGrp) verbGrp.style.display = currentStudyLang === 'de' && currentType === 'verb' ? 'flex' : 'none';

            const wordDeInput = document.getElementById('word-de');
            if (wordDeInput) {
                if (currentStudyLang === 'de') wordDeInput.placeholder = t('По-немецки...');
                else if (currentStudyLang === 'en') wordDeInput.placeholder = t('По-английски...');
                else if (currentStudyLang === 'ru') wordDeInput.placeholder = t('По-русски...');
                else wordDeInput.placeholder = t('Слово...');
            }
        };

        let dictTabFilter = 'active';
        let trainDirection = 'auto';
        let currentIsGermanQuestion = false;
        let currentArticle = 'der';
        let collapsedDictTopics = {};

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        let recognition = null;
        if (SpeechRecognition) { recognition = new SpeechRecognition(); recognition.interimResults = false; recognition.maxAlternatives = 1; }

        // Modern SRS: fixed stage intervals + soft penalty
        const SRS_INTERVALS = [0, 1, 3, 8, 21]; // days per stage 0..4
        const SRS_ARCHIVE_MULTIPLIER = 2.0;

        function calculateSRS(quality, currentScore, currentInterval) {
            currentScore = Number(currentScore) || 0;
            currentInterval = Number(currentInterval) || 0;

            let newScore, newInterval;

            if (quality >= 3) {
                // Success
                if (currentScore >= MAX_SCORE) {
                    // Already in Archive: keep stage, double the interval
                    newScore = MAX_SCORE;
                    newInterval = Math.round((currentInterval || SRS_INTERVALS[MAX_SCORE]) * SRS_ARCHIVE_MULTIPLIER);
                } else {
                    newScore = currentScore + 1;
                    newInterval = SRS_INTERVALS[newScore];
                }
            } else {
                // Soft penalty: drop one stage, min 0
                newScore = Math.max(currentScore - 1, 0);
                newInterval = 0; // return to session queue
            }

            return { newScore, newInterval };
        }

        // Legacy wrapper kept for any residual call-sites
        function calculateSM2(quality, repetitions, interval, easeFactor, currentScore) {
            const r = calculateSRS(quality, currentScore, interval);
            return { repetitions: r.newScore, interval: r.newInterval, easeFactor: easeFactor || 2.5 };
        }

        function formatInterval(days) {
            const dn = window.i18nDict && window.i18nDict['дн'] && currentLang !== 'ru' ? window.i18nDict['дн'][currentLang] : 'дн';
            const mes = window.i18nDict && window.i18nDict['мес'] && currentLang !== 'ru' ? window.i18nDict['мес'][currentLang] : 'мес';
            const g = window.i18nDict && window.i18nDict['г'] && currentLang !== 'ru' ? window.i18nDict['г'][currentLang] : 'г';

            days = Number(days) || 0;
            if (!days || days <= 0) return `1 ${dn}`;
            if (days < 30) return `${days} ${dn}`;
            if (days < 365) return `${(days / 30).toFixed(1).replace('.0', '')} ${mes}`;
            return `${(days / 365).toFixed(1).replace('.0', '')} ${g}`;
        }

        let isDevMode = localStorage.getItem('devMode') === 'true';
        function updateDevModeUI() {
            const devBtn = document.getElementById('dev-mode-btn');
            if (devBtn) {
                if (isDevMode) {
                    devBtn.className = "w-full flex items-center justify-between p-3.5 rounded-xl border-2 border-[#D4AF37] bg-[#D4AF37]/10 transition-all text-white mb-6 ";
                    devBtn.innerHTML = `<div class="flex items-center gap-2 min-w-0"><span class="text-xl drop-shadow-[0_0_8px_rgba(212,175,55,0.8)] flex-shrink-0">🛠️</span><span class="font-bold text-base text-[#D4AF37] truncate" data-orig-ru="Режим разработчика">Режим разработчика</span></div><span class="text-[10px] font-black bg-[#D4AF37] text-[#112240] px-2 py-0.5 rounded uppercase shadow-md flex-shrink-0 ml-2" data-orig-ru="Включен">Включен</span>`;
                } else {
                    devBtn.className = "w-full flex items-center justify-between p-3.5 rounded-xl border-2 border-transparent bg-[#172A45] transition-all hover:bg-[#112240] text-gray-400 mb-6";
                    devBtn.innerHTML = `<div class="flex items-center gap-2 min-w-0"><span class="text-xl opacity-50 grayscale flex-shrink-0">🛠️</span><span class="font-bold text-base truncate" data-orig-ru="Режим разработчика">Режим разработчика</span></div><span class="text-[10px] font-bold bg-[#112240] text-gray-500 border border-gray-700 px-2 py-0.5 rounded uppercase flex-shrink-0 ml-2" data-orig-ru="Выключен">Выключен</span>`;
                }
                if (typeof translateNode === 'function') translateNode(devBtn);
            }
        }

        window.toggleDevMode = () => {
            isDevMode = !isDevMode;
            localStorage.setItem('devMode', isDevMode);

            triggerVibration(15);

            if (isDevMode) {
                playTone(600, 'sine', 0.1); setTimeout(() => playTone(800, 'sine', 0.15), 100);
            }

            updateDevModeUI();
            updateProfileUI();
            if (!document.getElementById('view-dict').classList.contains('hidden')) renderDict();
        };
        updateDevModeUI();
        let premiumConfirmCallback = null;
        window.premiumConfirm = (message, callback) => {
            premiumConfirmCallback = callback;
            document.getElementById('premium-confirm-message').innerText = message;
            document.getElementById('premium-confirm-modal').classList.remove('hidden');
        };
        window.closePremiumConfirm = () => {
            document.getElementById('premium-confirm-modal').classList.add('hidden');
            premiumConfirmCallback = null;
        };
        window.executePremiumConfirm = () => {
            if (premiumConfirmCallback) premiumConfirmCallback();
            closePremiumConfirm();
        };

        let premiumPromptCallback = null;
        window.premiumPrompt = (title, defaultValue, callback) => {
            premiumPromptCallback = callback;
            document.getElementById('premium-prompt-title').innerText = title;
            const input = document.getElementById('premium-prompt-input');
            input.value = defaultValue;
            document.getElementById('premium-prompt-modal').classList.remove('hidden');
            setTimeout(() => { input.focus(); input.select(); }, 100);
        };
        window.closePremiumPrompt = () => {
            document.getElementById('premium-prompt-modal').classList.add('hidden');
            premiumPromptCallback = null;
        };
        window.executePremiumPrompt = () => {
            const val = document.getElementById('premium-prompt-input').value;
            if (premiumPromptCallback) premiumPromptCallback(val);
            closePremiumPrompt();
        };
        document.getElementById('premium-prompt-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') executePremiumPrompt();
        });

        let currentUser = localStorage.getItem('appUser');
        if (!currentUser) {
            document.getElementById('profile-modal').classList.remove('hidden');
        } else {
            document.getElementById('profile-modal').classList.add('hidden');
            document.getElementById('profile-close-btn').classList.remove('hidden');
        }

        // --- INDEXED DB OFFLINE OFFLINE-SYNC ---
        const dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open('worterbuch_idb', 1);
            request.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('words')) db.createObjectStore('words', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('sync_queue')) db.createObjectStore('sync_queue', { keyPath: 'id', autoIncrement: true });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        async function idbGetWords() {
            try {
                const db = await dbPromise;
                return new Promise(res => {
                    const tx = db.transaction('words', 'readonly');
                    const req = tx.objectStore('words').getAll();
                    req.onsuccess = () => res(req.result || []);
                });
            } catch (e) { return []; }
        }

        async function idbSaveWords(wordsList) {
            try {
                const db = await dbPromise;
                return new Promise(res => {
                    const tx = db.transaction('words', 'readwrite');
                    tx.objectStore('words').clear();
                    wordsList.forEach(w => tx.objectStore('words').put(w));
                    tx.oncomplete = () => res();
                });
            } catch (e) { }
        }

        async function queueOfflineUpdate(endpoint, method, payload) {
            try {
                const db = await dbPromise;
                return new Promise(res => {
                    const tx = db.transaction('sync_queue', 'readwrite');
                    tx.objectStore('sync_queue').put({ endpoint, method, payload, timestamp: Date.now() });
                    tx.oncomplete = () => res();
                });
            } catch (e) { }
        }

        async function processSyncQueue() {
            if (!navigator.onLine) return;
            try {
                const db = await dbPromise;
                const items = await new Promise(res => {
                    const tx = db.transaction('sync_queue', 'readonly');
                    const req = tx.objectStore('sync_queue').getAll();
                    req.onsuccess = () => res(req.result || []);
                });

                if (items.length > 0) {
                    console.log(`Syncing ${items.length} offline operations...`);
                    for (let item of items) {
                        const ok = await apiFetch(item.endpoint, { method: item.method, headers: { 'Content-Type': 'application/json' }, body: item.payload && JSON.stringify(item.payload), _isSync: true }).then(() => true).catch(() => false);
                        if (ok) {
                            await new Promise(res => {
                                const tx = db.transaction('sync_queue', 'readwrite');
                                tx.objectStore('sync_queue').delete(item.id);
                                tx.oncomplete = () => res();
                            });
                        }
                    }
                    console.log('Sync complete');
                    fetchWords();
                }
            } catch (e) { console.error(e); }
        }

        window.addEventListener('online', () => {
            setTimeout(processSyncQueue, 1500);
        });

        async function apiFetch(url, options = {}) {
            if (!currentUser) currentUser = 'osman';

            // If body is FormData, do NOT set headers object — browser must auto-set
            // Content-Type: multipart/form-data with correct boundary.
            // Instead, use Headers API to inject only x-user.
            if (options.body instanceof FormData) {
                const h = new Headers(options.headers || {});
                h.set('x-user', currentUser);
                options.headers = h;
            } else {
                if (!options.headers) options.headers = {};
                options.headers['x-user'] = currentUser;
            }

            const isScoreUpdate = url.includes('/score') && options.method === 'PUT';

            if (!navigator.onLine && isScoreUpdate && !options._isSync) {
                await queueOfflineUpdate(url, options.method, JSON.parse(options.body));
                return { ok: true, json: async () => ({ status: 'queued offline' }) };
            }

            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 4000);
            options.signal = controller.signal;

            try {
                const res = await fetch(url, options);
                clearTimeout(id);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res;
            } catch (e) {
                clearTimeout(id);
                if (isScoreUpdate && !options._isSync) {
                    await queueOfflineUpdate(url, options.method, JSON.parse(options.body));
                    return { ok: true, json: async () => ({ status: 'queued offline' }) };
                }
                throw e;
            }
        }

        async function syncAvatars() {
            if (!navigator.onLine) return;
            try {
                const res = await apiFetch('/profiles', { method: 'GET' });
                if (res.ok) {
                    const data = await res.json();
                    if (data.osman) localStorage.setItem('avatar_osman', data.osman);
                    if (data.girlfriend) localStorage.setItem('avatar_girlfriend', data.girlfriend);
                    loadAvatars();
                }
            } catch (e) { console.error('Avatar sync error:', e); }
        }

        function loadAvatars() {
            ['osman', 'girlfriend'].forEach(user => {
                const av = localStorage.getItem('avatar_' + user);
                const el = document.getElementById('avatar-' + user);
                if (av && el) {
                    el.style.backgroundImage = `url(${av})`; el.innerText = '';
                } else if (el) {
                    el.style.backgroundImage = 'none'; el.innerText = user === 'osman' ? 'О' : 'Д';
                }
            });
            const hdAv = document.getElementById('header-avatar');
            if (hdAv && currentUser) {
                const currentAv = localStorage.getItem('avatar_' + currentUser);
                if (currentAv) {
                    hdAv.style.backgroundImage = `url(${currentAv})`; hdAv.innerHTML = '';
                    hdAv.classList.replace('p-1.5', 'p-0'); hdAv.style.border = '1px solid #e5e7eb';
                } else {
                    hdAv.style.backgroundImage = 'none'; hdAv.classList.replace('p-0', 'p-1.5'); hdAv.style.border = 'none';
                    hdAv.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>`;
                }
            }
        }

        window.uploadAvatar = (user, input) => {
            if (!input.files[0]) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas'); const MAX_SIZE = 150;
                    let width = img.width, height = img.height; const size = Math.min(width, height);
                    canvas.width = MAX_SIZE; canvas.height = MAX_SIZE;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, (width - size) / 2, (height - size) / 2, size, size, 0, 0, MAX_SIZE, MAX_SIZE);
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
                    try {
                        localStorage.setItem('avatar_' + user, dataUrl);
                        loadAvatars();
                        if (navigator.onLine) {
                            apiFetch('/profile/avatar', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'x-user': user },
                                body: JSON.stringify({ avatar_base64: dataUrl })
                            }).catch(console.error);
                        }
                    }
                    catch (err) { alert(t("Файл слишком большой!")); console.error(err); }
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(input.files[0]);
            input.value = '';
        };

        function updateProfileUI() {
            if (!currentUser) return;
            document.getElementById('profile-btn-osman').className = currentUser === 'osman' ? "w-full flex items-center p-4 rounded-xl border-2 border-[#5A7B9C] bg-[#5A7B9C]/10 dark:bg-blue-900/20 transition-all text-white" : "w-full flex items-center p-4 rounded-xl border-2 border-transparent bg-[#172A45] dark:bg-[#172A45] transition-all hover:bg-[#112240] backdrop-blur-md bg-opacity-80 dark:hover:bg-gray-700 text-white";
            document.getElementById('profile-btn-girlfriend').className = currentUser === 'girlfriend' ? "w-full flex items-center p-4 rounded-xl border-2 border-pink-500 bg-pink-50 dark:bg-pink-900/20 transition-all text-white" : "w-full flex items-center p-4 rounded-xl border-2 border-transparent bg-[#172A45] dark:bg-[#172A45] transition-all hover:bg-[#112240] backdrop-blur-md bg-opacity-80 dark:hover:bg-gray-700 text-white";
            loadAvatars();

            ['de', 'en', 'ru'].forEach(l => {
                const btn = document.getElementById('lang-btn-' + l);
                if (btn) {
                    if (l === currentStudyLang) {
                        btn.className = "flex-1 py-3 bg-[#112240] rounded-xl font-bold text-white border-2 border-[#D4AF37] hover:bg-[#112240] transition-all flex items-center justify-center gap-2 shadow-sm text-sm";
                    } else {
                        btn.className = "flex-1 py-3 bg-[#172A45] rounded-xl font-bold text-gray-500 border-2 border-transparent hover:bg-[#112240] transition-all flex items-center justify-center gap-2 shadow-sm text-sm";
                    }
                }
            });
        }
        updateProfileUI();
        syncAvatars();

        window.setProfile = async (user) => {
            currentUser = user;
            localStorage.setItem('appUser', user);
            if (user === 'osman' && currentStudyLang !== 'de') await setStudyLanguage('de', true);
            else if (user === 'girlfriend' && currentStudyLang !== 'ru') await setStudyLanguage('ru', true);
            updateProfileUI();
            document.getElementById('profile-modal').classList.add('hidden');
            document.getElementById('profile-close-btn').classList.remove('hidden');
            globalWords = []; serverHistory = {};
            await switchView('dict');
        };

        const getLevelColor = (level) => {
            if (!level) return 'bg-[#112240] backdrop-blur-md bg-opacity-80 text-gray-500 dark:bg-[#172A45] dark:text-gray-500';
            const l = level.toUpperCase().replace(/А/g, 'A').replace(/В/g, 'B').replace(/С/g, 'C');
            return 'bg-[#0A192F] border border-[#D4AF37]/40 text-[#D4AF37] tracking-wider shadow-[0_0_6px_rgba(212,175,55,0.2)] font-black';
        };

        const updateIcons = () => { };


        const playTone = (freq, type, duration) => {
            try {
                if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                if (_audioCtx.state === 'suspended') _audioCtx.resume();
                const ac = _audioCtx;
                const osc = ac.createOscillator();
                const gain = ac.createGain();
                osc.type = type; osc.frequency.setValueAtTime(freq, ac.currentTime);
                gain.gain.setValueAtTime(0.1, ac.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + duration);
                osc.connect(gain); gain.connect(ac.destination);
                osc.start(); osc.stop(ac.currentTime + duration);
            } catch (e) { }
        };

        let _currentAudio = null;
        window.speakWord = (text, event, langOverride) => {
            if (event) event.stopPropagation();
            const lang = langOverride || currentStudyLang;
            const url = `/tts?text=${encodeURIComponent(text)}&lang=${lang}`;
            if (_currentAudio) {
                _currentAudio.pause();
                _currentAudio.src = '';
            }
            _currentAudio = new Audio(url);
            _currentAudio.play().catch(() => {
                window.speechSynthesis.cancel();
                const u = new SpeechSynthesisUtterance(text);
                if (lang === 'en') u.lang = 'en-US';
                else if (lang === 'ru') u.lang = 'ru-RU';
                else u.lang = 'de-DE';
                u.rate = 0.85;
                window.speechSynthesis.speak(u);
            });
        };
        window.activeInput = null; document.addEventListener('focusin', e => { if (e.target.tagName === 'INPUT') window.activeInput = e.target; });
        window.insertChar = (char, event) => {
            event.preventDefault(); if (!window.activeInput) return;
            const start = window.activeInput.selectionStart; const end = window.activeInput.selectionEnd; const val = window.activeInput.value;
            window.activeInput.value = val.slice(0, start) + char + val.slice(end); window.activeInput.selectionStart = window.activeInput.selectionEnd = start + 1; window.activeInput.dispatchEvent(new Event('input'));
        };

        async function saveSessionTime() {
            if (sessionStartMs > 0) {
                const elapsedMs = Date.now() - sessionStartMs;
                const tzoffset = (new Date()).getTimezoneOffset() * 60000;
                const localISOTime = (new Date(Date.now() - tzoffset)).toISOString().slice(0, 10);
                try { await apiFetch('/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date_str: localISOTime, ms_spent: elapsedMs }) }); } catch (e) { }
                sessionStartMs = 0;
            }
        }

        const views = { dict: document.getElementById('view-dict'), train: document.getElementById('view-train'), stats: document.getElementById('view-stats') };
        const navBtns = { dict: document.getElementById('nav-dict'), train: document.getElementById('nav-train'), stats: document.getElementById('nav-stats') };
        const isWordDue = (w) => Date.now() >= (w.next_review || 0);


        window.getDailyStats = () => {
            const dateStr = new Date().toISOString().slice(0, 10);
            const key = `dailyActivity_${currentUser}_${dateStr}`;
            let stats = { newWords: 0, reviews: 0 };
            try {
                if (localStorage.getItem(key)) stats = JSON.parse(localStorage.getItem(key));
            } catch (e) { }
            return { key, stats, dateStr };
        };



        window.updateDailyActivity = async (isNew, eventX, eventY) => {
            try {
                const res = await apiFetch('/progress/action', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action_type: isNew ? 'new' : 'review' })
                });
                const data = await res.json();
                if (data.status === 'success') {
                    showXPFloat(data.xp_added, eventX || (window.innerWidth / 2), (eventY || (window.innerHeight / 2 - 50)) - 20);
                    if (data.leveled_up) showLevelUp(data.new_level);
                    if (data.quest_completed) {
                        setTimeout(() => {
                            showXPFloat(500, window.innerWidth / 2, window.innerHeight / 2);
                            showLevelUp('Квест сдан!');
                        }, 500);
                    }
                    if (data.paragon_completed) {
                        setTimeout(() => {
                            showXPFloat(1000, window.innerWidth / 2, window.innerHeight / 2);
                            showLevelUp('Парагон!');
                        }, 500);
                    }
                    if (data.artifact) {
                        setTimeout(() => showArtifactDrop(data.artifact), 1000);
                    }
                    await window.updateExperience();
                }
            } catch(e) { console.error('Error posting progress action', e); }
        };


        window.showXPFloat = (xp, x, y) => {
            const el = document.createElement('div');
            el.className = 'xp-float';
            el.innerText = `+${xp} XP`;
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
            document.body.appendChild(el);
            setTimeout(() => el.remove(), 1200);
        };

        window.showLevelUp = (lvl) => {
            if (window.confetti) confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
            const toast = document.createElement('div');
            toast.className = 'lvl-up-toast';
            toast.innerText = `${t("Уровень повышен!")} ${lvl}`;
            document.body.appendChild(toast);
            triggerVibration([50, 100, 50]);
            setTimeout(() => {
                toast.style.animation = 'none';
                toast.style.opacity = '0';
                toast.style.transform = 'translate(-50%, -100%)';
                toast.style.transition = 'all 0.5s ease-out';
                setTimeout(() => toast.remove(), 500);
            }, 3000);
        };

        window.userProgressState = null;
        window.setTheme = function(theme) {
            localStorage.setItem('kraft_theme', theme);
            const btnD = document.getElementById('theme-btn-default');
            const btnG = document.getElementById('theme-btn-golden');
            if (theme === 'golden-abyss') {
                document.body.classList.add('theme-golden-abyss');
                if (btnG) btnG.classList.add('ring-2', 'ring-[#D4AF37]');
                if (btnD) btnD.classList.remove('ring-2', 'ring-gray-400');
            } else {
                document.body.classList.remove('theme-golden-abyss');
                if (btnD) btnD.classList.add('ring-2', 'ring-gray-400');
                if (btnG) btnG.classList.remove('ring-2', 'ring-[#D4AF37]');
            }
        };
        // Initial theme load
        if (localStorage.getItem('kraft_theme') === 'golden-abyss') {
            document.body.classList.add('theme-golden-abyss');
        }

        window.updateExperience = async () => {
            try {
                const res = await apiFetch('/progress');
                window.userProgressState = await res.json();
                
                let { level, current_xp, xp_for_next, daily_new_words, daily_reviews, rested_words_left, buff_active, paragon_completions, bonuses } = window.userProgressState;
                level = parseInt(level, 10);
                current_xp = parseInt(current_xp, 10);
                xp_for_next = parseInt(xp_for_next, 10);
                paragon_completions = parseInt(paragon_completions, 10) || 0;
                
                const pct = Math.min(100, Math.max(0, (current_xp / xp_for_next) * 100));

                let rankName = "Турист"; let rankIcon = `🧳`;
                if (level >= 11 && level <= 20) { rankName = "Мигрант"; rankIcon = `🛂`; }
                else if (level >= 21 && level <= 30) { rankName = "Студент"; rankIcon = `📚`; }
                else if (level >= 31 && level <= 40) { rankName = "Соискатель"; rankIcon = `📄`; }
                else if (level >= 41 && level <= 50) { rankName = "Работник"; rankIcon = `💼`; }
                else if (level >= 51 && level <= 60) { rankName = "Резидент"; rankIcon = `🏠`; }
                else if (level >= 61 && level <= 70) { rankName = "Гражданин"; rankIcon = `🏛️`; }
                else if (level >= 71) { rankName = "Местный"; rankIcon = `👑`; }

                ['prof-lvl', 'train-xp-lvl', 'vt-xp-lvl'].forEach(id => {
                    const el = document.getElementById(id);
                    if(el) el.innerText = id === 'prof-lvl' ? `Уровень ${level}` : `Lvl ${level}`;
                });
                ['prof-xp-text', 'train-xp-text', 'vt-xp-text'].forEach(id => {
                    const el = document.getElementById(id);
                    if(el) el.innerText = `${current_xp} / ${xp_for_next} XP`;
                });
                ['prof-xp-bar', 'train-xp-bar', 'vt-xp-bar'].forEach(id => {
                    const el = document.getElementById(id);
                    if(el) {
                        el.style.width = `${pct}%`;
                        if (rested_words_left > 0) el.className = "h-full bg-gradient-to-r from-[#8A2BE2] to-[#4B0082] transition-all duration-1000";
                        else el.className = "h-full bg-gradient-to-r from-[#D4AF37] to-[#FDE08B] transition-all duration-1000";
                    }
                });

                if (document.getElementById('prof-rank-name')) document.getElementById('prof-rank-name').innerText = rankName;
                if (document.getElementById('prof-league-icon')) document.getElementById('prof-league-icon').innerHTML = rankIcon;

                const buffSpark = document.getElementById('prof-buff-spark');
                if (buffSpark) buffSpark.classList.toggle('hidden', !buff_active);
                
                const restedText = document.getElementById('prof-rested-text');
                if (restedText) restedText.classList.toggle('hidden', rested_words_left === 0);

                const ringQuest = document.getElementById('ring-quest');
                const questText = document.getElementById('prof-quest-text');
                const artifactIndicator = document.getElementById('prof-artifact-chance-indicator');
                const totalDaily = daily_new_words + daily_reviews;
                
                if (ringQuest) {
                    const maxLen = 339.29; 
                    const baseTotal = totalDaily % 200;
                    if (paragon_completions > 0 || totalDaily >= 200) {
                        ringQuest.setAttribute('stroke', '#8B5CF6');
                        const pctQuest = (totalDaily % 200 === 0 && totalDaily > 0) ? 1 : Math.min(1, baseTotal / 200);
                        ringQuest.style.strokeDashoffset = maxLen - (maxLen * pctQuest);
                        if (questText) questText.innerHTML = `<span class="text-[#8B5CF6]">P${paragon_completions}</span> ${baseTotal}/200`;
                        if (artifactIndicator) artifactIndicator.classList.remove('hidden');
                    } else {
                        ringQuest.setAttribute('stroke', '#D4AF37');
                        const pctQuest = Math.min(1, totalDaily / 200);
                        ringQuest.style.strokeDashoffset = maxLen - (maxLen * pctQuest);
                        if (questText) questText.innerText = `${totalDaily}/200`;
                        if (artifactIndicator) artifactIndicator.classList.add('hidden');
                    }
                }

                const unlockedThemes = (bonuses && bonuses.unlocked_themes) ? bonuses.unlocked_themes : [];
                const themeContainer = document.getElementById('theme-selector-container');
                if (themeContainer) {
                    if (unlockedThemes.includes('golden_abyss')) {
                        themeContainer.classList.remove('hidden');
                        if (!localStorage.getItem('kraft_theme')) localStorage.setItem('kraft_theme', 'default');
                        window.setTheme(localStorage.getItem('kraft_theme'));
                    } else {
                        themeContainer.classList.add('hidden');
                    }
                }

                renderReputation();

            } catch(e) { console.error('XP fetch error', e); }

            const profMastered = document.getElementById('prof-mastered-text');
            const profTotal = document.getElementById('prof-total-text');
            const profVerbs = document.getElementById('prof-verbs-text');
            if (globalWords) {
                const mst = globalWords.filter(w => w.score >= MAX_SCORE).length;
                const vbs = globalWords.filter(w => w.word_type === 'verb' && w.score >= MAX_SCORE).length;
                
                if (profMastered) {
                    profMastered.innerText = mst;
                    profTotal.innerText = globalWords.length;
                    profVerbs.innerText = vbs;
                }
            }

            const dashAvatar = document.getElementById('prof-avatar');
            if (dashAvatar) {
                const currentAv = localStorage.getItem('avatar_' + currentUser);
                if (currentAv && currentAv.startsWith('data:')) {
                    dashAvatar.style.backgroundImage = `url(${currentAv})`;
                    dashAvatar.innerText = '';
                } else {
                    dashAvatar.style.backgroundImage = 'none';
                    dashAvatar.innerText = currentUser === 'osman' ? 'О' : (currentUser === 'girlfriend' ? 'Д' : 'U');
                }
            }
        };

        function renderReputation() {
            const container = document.getElementById('prof-reputation');
            if (!container) return;
            const folders = {};
            globalWords.forEach(w => {
                if (!folders[w.folder]) folders[w.folder] = { total: 0, mastered: 0 };
                folders[w.folder].total++;
                if (w.score >= MAX_SCORE) folders[w.folder].mastered++;
            });
                let html = '';
                for (let f in folders) {
                    const pct = Math.floor((folders[f].mastered / folders[f].total) * 100) || 0;
                    let repText = '', colorCls = '';
                    if (pct <= 20) { repText = 'Равнодушие'; colorCls = 'text-red-500'; }
                    else if (pct <= 40) { repText = 'Дружелюбие'; colorCls = 'text-orange-500'; }
                    else if (pct <= 60) { repText = 'Уважение'; colorCls = 'text-yellow-500'; }
                    else if (pct <= 80) { repText = 'Почтение'; colorCls = 'text-lime-500'; }
                    else { repText = 'Превознесение'; colorCls = 'text-green-500'; }

                    html += `
                    <div class="flex justify-between items-center bg-[#172A45]/50 p-3 rounded-xl border border-white/5">
                        <span class="text-sm text-gray-300 font-bold truncate pr-2">${escapeStr(f)}</span>
                        <div class="flex flex-col items-end">
                        <span class="text-[10px] uppercase font-bold tracking-widest ${colorCls}">${t(repText)}</span>
                        <span class="text-xs text-gray-500">Выучено: ${pct}%</span>
                    </div>
                </div>`;
            }
            container.innerHTML = html;
        }



        const ALL_ARTIFACTS = [
            { name: "Ржавый меч", rarity: "Обычный", emoji: "🗡️", color: "#6B7280", dropRate: "1.0" },
            { name: "Старый фолиант", rarity: "Обычный", emoji: "📓", color: "#6B7280", dropRate: "1.0" },
            { name: "Надколотый щит", rarity: "Обычный", emoji: "🛡️", color: "#6B7280", dropRate: "1.0" },
            { name: "Медный кубок", rarity: "Обычный", emoji: "🍷", color: "#6B7280", dropRate: "1.0" },
            { name: "Потускневшее кольцо", rarity: "Обычный", emoji: "💍", color: "#6B7280", dropRate: "1.0" },
            
            { name: "Загадочная призма", rarity: "Необычный", emoji: "🧊", color: "#10B981", dropRate: "0.5" },
            { name: "Искрящийся кристалл", rarity: "Необычный", emoji: "✨", color: "#10B981", dropRate: "0.5" },
            { name: "Темный оникс", rarity: "Необычный", emoji: "🌑", color: "#10B981", dropRate: "0.5" },
            { name: "Серебряный кинжал", rarity: "Необычный", emoji: "🔪", color: "#10B981", dropRate: "0.5" },
            { name: "Плащ теней", rarity: "Необычный", emoji: "🧥", color: "#10B981", dropRate: "0.5" },
            
            { name: "Сердце сумрака", rarity: "Редкий", emoji: "💜", color: "#3B82F6", dropRate: "0.1" },
            { name: "Слеза Сильваны", rarity: "Редкий", emoji: "💧", color: "#3B82F6", dropRate: "0.1" },
            { name: "Амулет бесконечности", rarity: "Редкий", emoji: "🧿", color: "#3B82F6", dropRate: "0.1" },
            { name: "Посох лунного света", rarity: "Редкий", emoji: "🦯", color: "#3B82F6", dropRate: "0.1" },
            { name: "Лазурный талисман", rarity: "Редкий", emoji: "💠", color: "#3B82F6", dropRate: "0.1" },
            
            { name: "Осколок пустоты", rarity: "Эпический", emoji: "🌌", color: "#8B5CF6", dropRate: "0.02" },
            { name: "Глаз бури", rarity: "Эпический", emoji: "👁️", color: "#8B5CF6", dropRate: "0.02" },
            { name: "Корона падшего короля", rarity: "Эпический", emoji: "👑", color: "#8B5CF6", dropRate: "0.02" },
            { name: "Рунический клинок", rarity: "Эпический", emoji: "⚔️", color: "#8B5CF6", dropRate: "0.02" },
            { name: "Чаша прозрения", rarity: "Эпический", emoji: "🏆", color: "#8B5CF6", dropRate: "0.02" },
            
            { name: "Испепелитель", rarity: "Легендарный", emoji: "🔥", color: "#F59E0B", dropRate: "0.005" },
            { name: "Клык Смертокрыла", rarity: "Легендарный", emoji: "🦷", color: "#F59E0B", dropRate: "0.005" },
            { name: "Свет Элуны", rarity: "Легендарный", emoji: "🌟", color: "#F59E0B", dropRate: "0.005" },
            { name: "Книга вечности", rarity: "Легендарный", emoji: "📖", color: "#F59E0B", dropRate: "0.005" },
            
            { name: "Око Саурона", rarity: "Мифический", emoji: "👁️‍🗨️", color: "#EF4444", dropRate: "0.001" },
            { name: "Клинок Хаоса", rarity: "Мифический", emoji: "🔥", color: "#EF4444", dropRate: "0.001" },
            { name: "Сфера мироздания", rarity: "Мифический", emoji: "🔮", color: "#EF4444", dropRate: "0.001" }
        ];

        async function openArtifactsCatalogModal() {
            try {
                const res = await apiFetch('/artifacts');
                const userArtifacts = await res.json();
                const obtainedNames = new Set(userArtifacts.map(a => a.artifact_name || a.name));
                
                const listEl = document.getElementById('artifacts-catalog-list');
                if (!listEl) return;
                
                const tenacitySet = ["Загадочная призма", "Искрящийся кристалл", "Темный оникс"];
                const tenacityCount = tenacitySet.filter(n => obtainedNames.has(n)).length;
                const tenacityActive = tenacityCount >= 3;
                
                const restSet = ["Сердце сумрака", "Слеза Сильваны", "Амулет бесконечности"];
                const restCount = restSet.filter(n => obtainedNames.has(n)).length;
                const restActive = restCount >= 3;
                
                let html = `
                    <div class="mb-4 bg-[#172A45]/30 p-3 rounded-xl border border-white/5 space-y-2">
                        <div class="flex justify-between items-center text-[10px] sm:text-xs">
                            <div><span class="font-bold text-[#10B981]">Сет «Упорство»</span> <span class="text-gray-400 ml-1">(+2% XP)</span></div>
                            <div class="font-bold ${tenacityActive ? 'text-[#10B981]' : 'text-gray-500'}">${tenacityCount}/3 ${tenacityActive ? '✓' : ''}</div>
                        </div>
                        <div class="flex justify-between items-center text-[10px] sm:text-xs">
                            <div><span class="font-bold text-[#3B82F6]">Сет «Пробуждение»</span> <span class="text-gray-400 ml-1">(Отдых 30 слов)</span></div>
                            <div class="font-bold ${restActive ? 'text-[#3B82F6]' : 'text-gray-500'}">${restCount}/3 ${restActive ? '✓' : ''}</div>
                        </div>
                    </div>
                `;
                html += '<div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-4">';
                
                ALL_ARTIFACTS.forEach(art => {
                    const obtained = obtainedNames.has(art.name);
                    const borderCol = obtained ? art.color : '#4B5563'; // Gray border if missing
                    const opacityCls = obtained ? '' : 'opacity-40 grayscale';
                    const glowCls = obtained ? `box-shadow: 0 0 15px ${art.color}60 inset` : '';
                    
                    html += `
                        <div class="aspect-square rounded-xl bg-[#0a1128] border-2 flex flex-col items-center justify-center p-2 relative group transition-transform ${obtained ? 'hover:scale-105 cursor-help' : 'cursor-not-allowed'} ${opacityCls}" 
                            style="border-color: ${borderCol}; ${glowCls}" title="${escapeStr(art.name)} (${escapeStr(art.rarity)})">
                            <span class="text-3xl drop-shadow-md mb-2">${art.emoji}</span>
                            <span class="text-[9px] text-center font-bold text-gray-300 leading-tight uppercase tracking-wider hidden sm:block">${escapeStr(art.name)}</span>
                            
                            <div class="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 hidden group-hover:block w-32 bg-[#172A45] text-xs text-white text-center p-2 rounded-lg shadow-lg border border-gray-600 z-50 pointer-events-none">
                                <p class="font-bold mb-1" style="color:${art.color}">${escapeStr(art.rarity)}</p>
                                <p>${escapeStr(art.name)}</p>
                                <p class="text-[10px] text-gray-400 mt-1">Шанс: ${art.dropRate}%</p>
                                ${!obtained ? '<p class="text-gray-500 mt-1 text-[10px]">Не получено</p>' : ''}
                            </div>
                        </div>
                    `;
                });
                
                html += '</div>';
                listEl.innerHTML = html;
                
                document.getElementById('artifacts-catalog-modal').classList.remove('hidden');
            } catch(e) { console.error('Error opening artifacts catalog', e); }
        }

        async function renderArtifacts() {
            const container = document.getElementById('prof-artifacts');
            if (!container) return;
            
            try {
                const res = await apiFetch('/artifacts');
                const artifacts = await res.json();
                
                let html = '';
                const totalSlots = Math.max(8, Math.ceil(artifacts.length / 4) * 4);
                
                for (let i = 0; i < totalSlots; i++) {
                    if (i < artifacts.length) {
                        const art = artifacts[i];
                        let colorHex = '#10B981';
                        let emoji = '💠';
                        
                        const globalArt = ALL_ARTIFACTS.find(a => a.name === (art.artifact_name || art.name));
                        if (globalArt) {
                            colorHex = globalArt.color;
                            emoji = globalArt.emoji;
                        } else {
                            if (art.rarity === 'Обычный') { colorHex = '#6B7280'; emoji = '🗡️'; }
                            else if (art.rarity === 'Необычный') { colorHex = '#10B981'; emoji = '🌿'; }
                            else if (art.rarity === 'Редкий') { colorHex = '#3B82F6'; emoji = '💧'; }
                            else if (art.rarity === 'Эпический') { colorHex = '#8B5CF6'; emoji = '🔮'; }
                            else if (art.rarity === 'Легендарный') { colorHex = '#F59E0B'; emoji = '👑'; }
                            else if (art.rarity === 'Мифический') { colorHex = '#EF4444'; emoji = '👁️‍🗨️'; }
                        }
                        
                        const artName = art.artifact_name || art.name;
                        html += `
                        <div class="w-full aspect-square rounded-xl bg-[#0a1128] border-2 shadow-inner flex items-center justify-center relative cursor-help group transition-transform hover:scale-105" 
                            style="border-color: ${colorHex}; box-shadow: 0 0 10px ${colorHex}40 inset" title="${escapeStr(artName)} (${escapeStr(art.rarity)})">
                            <span class="text-2xl drop-shadow-md">${emoji}</span>
                            <div class="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 hidden group-hover:block w-32 bg-[#172A45] text-xs text-white text-center p-2 rounded-lg shadow-lg border border-gray-600 z-50 pointer-events-none">
                                <p class="font-bold" style="color:${colorHex}">${escapeStr(art.rarity)}</p>
                                <p>${escapeStr(artName)}</p>
                            </div>
                        </div>
                        `;
                    } else {
                        html += `
                        <div class="w-full aspect-square rounded-xl bg-[#172A45]/30 border border-white/5 flex items-center justify-center opacity-50">
                        </div>
                        `;
                    }
                }
                container.innerHTML = html;
            } catch(e) { console.error('Error fetching artifacts', e); }
        }

        window.fetchWords = async () => {
            try {
                if (!navigator.onLine) throw new Error('Offline mode');
                const res = await apiFetch(API_URL); const data = await res.json();
                if (Array.isArray(data)) {
                    const allWords = data.map(w => ({ ...w, ease_factor: w.ease_factor || 2.5, interval: w.interval || 0, repetitions: w.repetitions || 0 }));
                    await idbSaveWords(allWords);
                    globalWords = allWords.filter(w => (w.target_lang || 'de') === currentStudyLang);
                    updateExperience();
                }
                setTimeout(processSyncQueue, 500);
            } catch (e) {
                try {
                    const offDb = await idbGetWords();
                    if (offDb && offDb.length > 0) {
                        globalWords = offDb.filter(w => (w.target_lang || 'de') === currentStudyLang);
                        console.log("Loaded words from IndexedDB.");
                    } else {
                        const saved = localStorage.getItem('offline_words_db');
                        if (saved) {
                            const parsed = JSON.parse(saved);
                            if (Array.isArray(parsed)) {
                                const allWords = parsed;
                                globalWords = allWords.filter(w => (w.target_lang || 'de') === currentStudyLang);
                                await idbSaveWords(allWords);
                            }
                        }
                    }
                } catch (err) { }
            }
            if (!Array.isArray(globalWords)) globalWords = [];
            updateExperience();
            try {
                document.getElementById('folder-list').innerHTML = [...new Set(globalWords.map(w => w.folder))].filter(Boolean).map(f => `<option value="${escapeStr(f)}">`).join('');
                document.getElementById('level-list').innerHTML = [...new Set(globalWords.map(w => w.level).filter(Boolean))].map(l => `<option value="${escapeStr(l)}">`).join('');
                document.getElementById('subfolder-list').innerHTML = [...new Set(globalWords.map(w => w.subfolder))].filter(Boolean).map(s => `<option value="${escapeStr(s)}">`).join('');
            } catch (e) { console.error("Error rendering dict datalists:", e); }
        };

        async function switchView(target) {
            if (globalWords.length === 0) await fetchWords();
            triggerVibration(10);
            if (target !== 'train') saveSessionTime();

            const viewKeys = Object.keys(views);
            const currentObj = viewKeys.find(k => !views[k].classList.contains('hidden'));
            const currentIndex = viewKeys.indexOf(currentObj || 'dict');
            const targetIndex = viewKeys.indexOf(target);
            const isForward = targetIndex > currentIndex;

            setTimeout(() => {
                try {
                    if (target === 'dict') renderDict();
                    if (target === 'train') setupTrainMenu();
                    if (target === 'stats') loadStats();
                    translateNode(document.body);
                } catch (e) { console.error("Error in switchView components:", e); }
            }, 150);

            viewKeys.forEach(v => {
                const isActive = (v === target);
                const el = views[v];
                if (isActive) {
                    el.classList.remove('hidden');
                    el.style.opacity = '0';
                    el.style.transform = 'translateY(15px)';
                    el.style.transition = 'opacity 0.35s ease, transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)';
                    // Trigger reflow
                    void el.offsetHeight;
                    el.style.opacity = '1';
                    el.style.transform = 'translateY(0)';

                    navBtns[v].classList.add('active-tab');
                    navBtns[v].classList.remove('text-gray-500');
                } else {
                    el.classList.add('hidden');
                    el.style.transition = '';
                    navBtns[v].classList.remove('active-tab');
                    navBtns[v].classList.add('text-gray-500');
                }
            });

            document.getElementById('header-title').innerText = t({ dict: 'Словарь', train: 'Тренировка', stats: 'Прогресс' }[target]);
            document.getElementById('add-btn').classList.toggle('hidden', target !== 'dict');

            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        navBtns.dict.onclick = () => switchView('dict');
        navBtns.train.onclick = () => switchView('train');

        navBtns.stats.onclick = () => switchView('stats');

        window.selectArticle = (art) => {
            currentArticle = art;
            const btns = { der: document.getElementById('btn-art-der'), die: document.getElementById('btn-art-die'), das: document.getElementById('btn-art-das') };
            Object.values(btns).forEach(b => { b.className = "flex-1 py-2 rounded-lg border-2 border-transparent bg-[#172A45] dark:bg-[#172A45] text-gray-500 font-medium transition-all text-sm hover:bg-[#112240] backdrop-blur-md bg-opacity-80 dark:hover:bg-gray-700"; });
            if (art === 'der') btns.der.className = "flex-1 py-2 rounded-lg border-2 border-[#5A7B9C] bg-[#5A7B9C]/10 dark:bg-blue-900/30 text-[#AA7C11] dark:text-[#FDE08B] font-medium transition-all shadow-sm text-sm";
            else if (art === 'die') btns.die.className = "flex-1 py-2 rounded-lg border-2 border-[#9C5A5A] bg-[#9C5A5A]/10 dark:bg-red-900/30 text-[#9C5A5A] dark:text-red-400 font-medium transition-all shadow-sm text-sm";
            else if (art === 'das') btns.das.className = "flex-1 py-2 rounded-lg border-2 border-[#D4AF37] bg-green-50 dark:bg-green-900/30 text-[#5A9C78] dark:text-green-400 font-medium transition-all shadow-sm text-sm";
        };

        const wordInp = document.getElementById('word-de');
        wordInp.oninput = () => {
            if (currentType !== 'noun') return;
            const w = wordInp.value.trim().toLowerCase(); let g = null;
            if (w.match(/(ung|heit|keit|schaft|tion|tät|ik|ur|enz|anz|ie|e)$/)) g = 'die';
            else if (w.match(/(chen|lein|ment|um|ma|nis|o)$/)) g = 'das';
            else if (w.match(/(ismus|ling|ig|or|ist|ant|ent|er)$/)) g = 'der';
            if (g && currentArticle !== g) selectArticle(g);
        };

        document.getElementById('dict-tab-active').onclick = () => { dictTabFilter = 'active'; renderDictTabs(); };
        document.getElementById('dict-tab-mastered').onclick = () => { dictTabFilter = 'mastered'; renderDictTabs(); };
        function renderDictTabs() {
            document.getElementById('dict-tab-active').className = dictTabFilter === 'active' ? "flex-1 py-1.5 text-xs font-bold rounded-lg bg-[#2A3B5E] shadow-sm transition-all text-white" : "flex-1 py-1.5 text-xs font-bold rounded-lg text-gray-500 transition-all hover:text-gray-700 dark:hover:text-[#D4AF37]";
            document.getElementById('dict-tab-mastered').className = dictTabFilter === 'mastered' ? "flex-1 py-1.5 text-xs font-bold rounded-lg bg-[#2A3B5E] shadow-sm transition-all flex items-center justify-center gap-1 text-white" : "flex-1 py-1.5 text-xs font-bold rounded-lg text-gray-500 transition-all flex items-center justify-center gap-1 hover:text-gray-700 dark:hover:text-[#D4AF37]";
            renderDict();
        }

        const searchInp = document.getElementById('search-input');
        let _searchDebounce;
        searchInp.oninput = () => {
            clearTimeout(_searchDebounce);
            _searchDebounce = setTimeout(() => {
                const clearBtn = document.getElementById('search-clear-btn');
                if (searchInp.value.length > 0) clearBtn.classList.remove('hidden'); else clearBtn.classList.add('hidden');
                renderDict(searchInp.value.toLowerCase());
            }, 250);
        };
        window.toggleFolder = (folderName) => {
            const topicsContainer = document.querySelector(`.dict-topics-container[data-folder="${CSS.escape(folderName)}"]`);
            if (topicsContainer) {
                const isNowHidden = topicsContainer.classList.toggle('hidden');
                collapsedDictTopics['folder_' + folderName] = isNowHidden;
                const chevron = document.querySelector(`[data-folder-header="${CSS.escape(folderName)}"] .folder-chevron`);
                if (chevron) chevron.classList.toggle('rotate-180', !isNowHidden);
            }
        };

        window.toggleTopic = (topicKey) => {
            const wordsContainer = document.getElementById(`topic-words-${topicKey}`);
            if (wordsContainer) {
                if (wordsContainer.getAttribute('data-loaded') !== 'true') {
                    wordsContainer.innerHTML = window._topicHtmlCache[topicKey] || '';
                    wordsContainer.setAttribute('data-loaded', 'true');
                }
                const isNowHidden = wordsContainer.classList.toggle('hidden');
                collapsedDictTopics[topicKey] = isNowHidden;
                const chevron = document.querySelector(`.dict-topic[data-topic="${CSS.escape(topicKey)}"] .topic-chevron`);
                if (chevron) chevron.classList.toggle('rotate-180', !isNowHidden);
            }
        };

        function renderDict(query = searchInp.value.toLowerCase()) {
            const container = document.getElementById('dict-list');
            try {
                let filtered = globalWords.filter(w => (w.word_de || "").toLowerCase().includes(query) || (w.word_ru || "").toLowerCase().includes(query));
                if (dictTabFilter === 'active') filtered = filtered.filter(w => w.score < MAX_SCORE);
                else filtered = filtered.filter(w => w.score >= MAX_SCORE);

                if (filtered.length === 0) {
                    container.innerHTML = `<div class="text-center py-20"><p class="text-gray-500 font-medium text-sm">${dictTabFilter === 'mastered' ? 'Архив пуст ' : 'Отлично! Все текущие слова выучены '}</p></div>`; return;
                }

                const colors = { der: 'text-der', die: 'text-die', das: 'text-das' };
                const grouped = {};
                filtered.forEach(w => {
                    const f = w.folder || 'Без курса'; const l = w.level || 'Общее'; const s = w.subfolder || 'Без темы';
                    if (!grouped[f]) grouped[f] = {}; if (!grouped[f][l]) grouped[f][l] = {}; if (!grouped[f][l][s]) grouped[f][l][s] = [];
                    grouped[f][l][s].push(w);
                });

                let savedFolderOrder = []; let savedTopicOrder = {};
                try { savedFolderOrder = JSON.parse(localStorage.getItem('folderOrder')) || []; } catch (e) { }
                try { savedTopicOrder = JSON.parse(localStorage.getItem('topicOrder')) || {}; } catch (e) { }

                const folderNames = Object.keys(grouped).sort((a, b) => { let idxA = savedFolderOrder.indexOf(a); let idxB = savedFolderOrder.indexOf(b); if (idxA === -1) idxA = 9999; if (idxB === -1) idxB = 9999; return idxA - idxB; });

                let html = '<div id="dict-folders-container">';
                folderNames.forEach(f => {
                    const safeF = escapeStr(f);
                    if (collapsedDictTopics['folder_' + f] === undefined) collapsedDictTopics['folder_' + f] = true;
                    const isFolderCollapsed = collapsedDictTopics['folder_' + f];
                    const folderChevronClass = isFolderCollapsed ? '' : 'rotate-180';

                    html += `
                    <div class="dict-folder mb-4 bg-[#112240] rounded-2xl overflow-hidden border border-white/5" data-folder="${safeF}">
                        <div class="flex items-center justify-between px-4 py-3 border-b border-white/5 cursor-pointer hover:bg-[#172A45] transition-colors" data-folder-header="${safeF}" onclick="toggleFolder('${safeF}')">
                            <div class="flex items-center gap-3 flex-1 min-w-0">
                                <div class="cursor-move drag-handle-folder text-gray-600 hover:text-white transition-colors flex-shrink-0" onclick="event.stopPropagation()"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8h16M4 16h16"/></svg></div>
                                <h2 class="text-base font-bold text-white truncate notranslate" ${isDevMode ? `onclick="event.stopPropagation(); renameFolder('${safeF}')" style="cursor:pointer;" title="Переименовать"` : ''}>${f}</h2>
                            </div>
                            <div class="flex items-center gap-2">
                            ${isDevMode ? `<div class="flex items-center gap-1">
                                <button onclick="fastAddCourse('${safeF}'); event.stopPropagation();" class="p-1.5 text-[#34d399] hover:bg-[#34d399]/10 rounded-full transition-colors"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg></button>
                                <button onclick="renameFolder('${safeF}'); event.stopPropagation();" class="p-1.5 text-[#D4AF37]/60 hover:text-[#D4AF37] rounded-full transition-colors"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg></button>
                                <button onclick="premiumConfirm(t('Удалить курс со всеми словами внутри?'), () => deleteCourse('${safeF}')); event.stopPropagation();" class="p-1.5 text-red-400/60 hover:text-red-400 rounded-full transition-colors"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>
                            </div>` : ''}
                            <svg class="folder-chevron w-5 h-5 text-gray-500 transition-transform ${folderChevronClass}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                            </div>
                        </div>
                        <div class="dict-topics-container p-2 space-y-1${isFolderCollapsed ? ' hidden' : ''}" data-folder="${safeF}">
                    `;

                    let topics = [];
                    for (const l in grouped[f]) { for (const s in grouped[f][l]) { topics.push({ l, s, words: grouped[f][l][s], key: `${f}|${l}|${s}` }); } }
                    topics.sort((a, b) => { let orderArr = savedTopicOrder[f] || []; let idxA = orderArr.indexOf(a.key); let idxB = orderArr.indexOf(b.key); if (idxA === -1) idxA = 9999; if (idxB === -1) idxB = 9999; return idxA - idxB; });

                    topics.forEach(topic => {
                        const l = topic.l; const s = topic.s; const wordsInTopic = topic.words; const topicKey = topic.key;
                        const safeL = escapeStr(l); const safeS = escapeStr(s); const safeTopicKey = escapeStr(topicKey);
                        if (collapsedDictTopics[topicKey] === undefined) collapsedDictTopics[topicKey] = true;
                        const isTopicCollapsed = collapsedDictTopics[topicKey];
                        const topicChevronClass = isTopicCollapsed ? '' : 'rotate-180';

                        html += `
                        <div class="dict-topic bg-[#112240] rounded-xl border border-white/5 mb-2 overflow-hidden" data-topic="${safeTopicKey}">
                            <div class="flex items-center justify-between px-4 py-2 bg-[#172A45]/50 border-b border-white/5 cursor-pointer hover:bg-[#1e3357] transition-colors" onclick="toggleTopic('${safeTopicKey}')">
                                <div class="flex items-center gap-2 min-w-0 flex-1">
                                    <div class="cursor-move drag-handle-topic text-gray-600 hover:text-white transition-colors flex-shrink-0" onclick="event.stopPropagation()"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8h16M4 16h16"/></svg></div>
                                    ${l !== 'Общее' ? `<span class="text-[10px] font-black px-2 py-0.5 rounded-md flex-shrink-0 bg-[#0b101e] border border-[#D4AF37]/40 text-[#D4AF37] tracking-wider shadow-[0_0_6px_rgba(212,175,55,0.2)]">${l}</span>` : ''}
                                    <span class="text-sm font-semibold text-gray-200 truncate notranslate">${s}</span>
                                    <span class="text-xs text-gray-500 flex-shrink-0 ml-1">${wordsInTopic.length} ${t('слов')}</span>

                                </div>
                                <div class="flex items-center gap-1 flex-shrink-0">
                                    ${isDevMode ? `<button onclick="renameSubfolder('${safeF}','${safeL}','${safeS}'); event.stopPropagation();" class="p-1 text-gray-600 hover:text-[#D4AF37] transition-colors"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg></button>` : ''}
                                    <button onclick="addWordToTopic('${safeF}','${safeL}','${safeS}'); event.stopPropagation();" class="p-1 text-gray-600 hover:text-[#D4AF37] transition-colors"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg></button>
                                    <svg class="topic-chevron w-5 h-5 text-gray-500 transition-transform ${topicChevronClass}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                                </div>
                            </div>
                            <div id="topic-words-${safeTopicKey}" data-loaded="${isTopicCollapsed && query.length === 0 ? 'false' : 'true'}" class="p-2 space-y-1 bg-[#0A192F]${isTopicCollapsed ? ' hidden' : ''}">
                        `;

                        window._topicHtmlCache = window._topicHtmlCache || {};
                        let topicHtmlCacheStr = '';

                        wordsInTopic.forEach(w => {
                            let extraInfo = '';
                            if (w.word_type === 'noun' && w.plural) extraInfo = `(pl. ${w.plural})`;
                            else if (w.word_type === 'verb' && (w.praeteritum || w.partizip)) extraInfo = `(${w.praeteritum || '-'}, ${w.partizip || '-'})`;
                            const safeWordDe = escapeStr(w.word_de);
                            topicHtmlCacheStr += `
                            <div onclick="openEdit(${w.id})" class="bg-[#172A45] p-3 rounded-xl flex justify-between items-center cursor-pointer hover:bg-[#1e3357] transition-colors border border-l-4 card-rarity-${Math.min(w.score, 4)} ${w.score >= MAX_SCORE ? 'border-l-yellow-500' : w.score === 3 ? 'border-l-purple-500' : w.score === 2 ? 'border-l-blue-500' : w.score === 1 ? 'border-l-green-500' : 'border-l-gray-600'}">
                                <div class="flex-1 pr-3 min-w-0">
                                    <p class="text-base font-bold text-white leading-tight truncate notranslate">${w.word_type === 'noun' ? `<span class="${colors[w.article]} font-medium mr-1">${w.article}</span>` : ''}${w.word_de} <span class="text-gray-500 text-xs font-normal">${extraInfo}</span></p>
                                    <p class="text-gray-400 text-sm mt-0.5 truncate notranslate">${w.word_ru}</p>
                                    ${w.example ? `<p class="text-[11px] text-blue-300/60 mt-1 truncate notranslate">${escapeStr(w.example.split(/[-—(/\[]/)[0].trim())}</p>` : ''}
                                </div>
                                <div class="flex flex-col items-end gap-1.5 flex-shrink-0">
                                    <div class="flex gap-1">
                                        <button onclick="speakWord('${(w.word_type === 'noun' ? w.article + ' ' : '') + safeWordDe}', event)" class="p-1.5 rounded-full text-gray-500 hover:text-[#D4AF37] transition-colors"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072M5 10v4a2 2 0 002 2h2l4 4V4L9 8H7a2 2 0 00-2 2z"/></svg></button>
                                        <button onclick="deleteWord(${w.id}, event)" class="p-1.5 rounded-full text-gray-500 hover:text-red-400 transition-colors"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>
                                    </div>
                                    <span class="text-xs font-bold ${w.score >= MAX_SCORE ? 'text-[#5A9C78]' : (w.score >= 3 ? 'text-orange-500' : 'text-gray-600')}">${Math.min(w.score, MAX_SCORE)}/${MAX_SCORE}</span>
                                </div>
                            </div>`;
                        });
                        window._topicHtmlCache[safeTopicKey] = topicHtmlCacheStr;
                        if (!isTopicCollapsed || query.length > 0) html += topicHtmlCacheStr;

                        html += `</div></div>`;
                    });
                    html += `</div></div>`;
                });
                html += '</div>';

                container.innerHTML = html;
                // Init sortable after render
                setTimeout(initSortable, 100);
            } catch (err) { console.error('RenderDict error:', err); container.innerHTML = `<div class="text-center py-20 text-[#9C5A5A]">Ошибка рендера. Очистите кэш.</div>`; }
        }

        function initSortable() {
            if (typeof Sortable === 'undefined') { setTimeout(initSortable, 500); return; }
            const folderContainer = document.getElementById('dict-folders-container');
            if (folderContainer) {
                new Sortable(folderContainer, {
                    handle: '.drag-handle-folder', animation: 250, delay: 150, delayOnTouchOnly: true, ghostClass: 'sortable-ghost',
                    onEnd: function () {
                        if (document.getElementById('search-input').value.trim().length > 0) return;
                        const order = Array.from(folderContainer.querySelectorAll('.dict-folder')).map(el => el.getAttribute('data-folder'));
                        localStorage.setItem('folderOrder', JSON.stringify(order));
                    }
                });
                folderContainer._sortableInited = true;
            }
            document.querySelectorAll('.dict-topics-container').forEach(topicContainer => {
                new Sortable(topicContainer, {
                    handle: '.drag-handle-topic', animation: 250, delay: 150, delayOnTouchOnly: true, ghostClass: 'sortable-ghost',
                    onEnd: function (evt) {
                        if (document.getElementById('search-input').value.trim().length > 0) return;
                        const f = evt.item.closest('.dict-folder').getAttribute('data-folder');
                        const order = Array.from(evt.item.closest('.dict-topics-container').querySelectorAll('.dict-topic')).map(el => el.getAttribute('data-topic'));
                        let savedTopicOrder = {}; try { savedTopicOrder = JSON.parse(localStorage.getItem('topicOrder')) || {}; } catch (e) { }
                        savedTopicOrder[f] = order; localStorage.setItem('topicOrder', JSON.stringify(savedTopicOrder));
                    }
                });
            });
        }

        window.renameFolder = async (oldFolder) => {
            premiumPrompt(t('Новое название для курса:') + '\\n"' + oldFolder + '"', oldFolder, async (newFolder) => {
                if (newFolder && newFolder.trim() !== '' && newFolder.trim() !== oldFolder) {
                    try { await apiFetch('/words/rename_folder', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ old_folder: oldFolder, new_folder: newFolder.trim() }) }); await fetchWords(); renderDict(); } catch (e) { alert(t('Ошибка сети!')); }
                }
            });
        };

        window.renameSubfolder = async (f, l, oldS) => {
            premiumPrompt(t('Новое название для темы:') + '\\n"' + oldS + '"', oldS, async (newS) => {
                if (newS && newS.trim() !== '' && newS.trim() !== oldS) {
                    try {
                        await apiFetch('/words/rename_subfolder', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: f, level: l, old_subfolder: oldS, new_subfolder: newS.trim() }) });
                        const oldKey = `${f}|${l}|${oldS}`; const newKey = `${f}|${l}|${newS.trim()}`;
                        if (collapsedDictTopics[oldKey] !== undefined) { collapsedDictTopics[newKey] = collapsedDictTopics[oldKey]; delete collapsedDictTopics[oldKey]; }
                        await fetchWords(); renderDict();
                    } catch (e) { alert(t('Ошибка сети!')); }
                }
            });
        };

        const modal = document.getElementById('add-modal');
        const setType = (t) => {
            currentType = t;
            document.getElementById('type-noun').className = t === 'noun' ? "flex-1 py-2 text-xs font-bold uppercase tracking-wide rounded-md bg-[#2A3B5E] shadow-sm transition-all text-white" : "flex-1 py-2 text-xs font-bold uppercase tracking-wide text-gray-500 transition-all hover:text-gray-700 dark:hover:text-[#D4AF37]";
            document.getElementById('type-verb').className = t === 'verb' ? "flex-1 py-2 text-xs font-bold uppercase tracking-wide rounded-md bg-[#2A3B5E] shadow-sm transition-all text-white" : "flex-1 py-2 text-xs font-bold uppercase tracking-wide text-gray-500 transition-all hover:text-gray-700 dark:hover:text-[#D4AF37]";

            // Base visibility overrides for types
            document.getElementById('plural-input-group').style.display = t === 'verb' ? 'none' : 'flex';

            // Defer to language-specific setup
            if (typeof setupAddWordModal === 'function') setupAddWordModal();
        };

        document.getElementById('type-noun').onclick = () => setType('noun');
        document.getElementById('type-verb').onclick = () => setType('verb');

        const showSingleTab = () => {
            document.getElementById('form-single').classList.remove('hidden'); document.getElementById('form-bulk').classList.add('hidden');
            document.getElementById('tab-single').className = "flex-1 py-2 text-sm font-medium rounded-lg bg-[#2A3B5E] shadow-sm transition-all text-white";
            document.getElementById('tab-bulk').className = "flex-1 py-2 text-sm font-medium rounded-lg text-gray-500 transition-all hover:text-gray-700 dark:hover:text-[#D4AF37]";
        };
        const showBulkTab = () => {
            document.getElementById('form-bulk').classList.remove('hidden'); document.getElementById('form-single').classList.add('hidden');
            document.getElementById('tab-bulk').className = "flex-1 py-2 text-sm font-bold rounded-lg bg-[#5A9C78] text-white shadow-md shadow-green-500/40 transition-all transform scale-[1.02]";
            document.getElementById('tab-single').className = "flex-1 py-2 text-sm font-medium rounded-lg text-gray-500 transition-all hover:text-gray-700 dark:hover:text-[#D4AF37]";
        };

        document.getElementById('tab-single').onclick = showSingleTab;
        document.getElementById('tab-bulk').onclick = showBulkTab;

        document.getElementById('add-btn').onclick = () => {
            editId = null; document.getElementById('modal-title').innerText = "Новое слово"; document.getElementById('add-form').reset(); checkDuplicate();
            document.getElementById('bulk-folder').value = ''; document.getElementById('bulk-level').value = ''; document.getElementById('bulk-subfolder').value = '';
            const bulkFile = document.getElementById('bulk-file'); if (bulkFile) bulkFile.value = '';
            const bulkLabel = document.getElementById('bulk-file-label'); if (bulkLabel) bulkLabel.innerText = 'Выбрать CSV файл';
            setType('noun'); showSingleTab(); selectArticle('der'); modal.classList.remove('hidden');
        };
        document.getElementById('close-modal').onclick = () => modal.classList.add('hidden');

        window.addWordToTopic = (folder, level, subfolder) => {
            editId = null;
            document.getElementById('modal-title').innerText = "Новое слово";
            document.getElementById('btn-save').innerText = "Добавить";
            document.getElementById('add-form').reset();

            setType('noun');
            document.getElementById('word-folder').value = folder;
            document.getElementById('word-level').value = level;
            document.getElementById('word-subfolder').value = subfolder;
            showSingleTab();
            modal.classList.remove('hidden');
        };

        window.openEdit = (id) => {
            const w = globalWords.find(x => x.id === id); if (!w) return;
            editId = w.id; document.getElementById('modal-title').innerText = "Редактировать"; showSingleTab();
            setType(w.word_type); if (w.word_type === 'noun') selectArticle(w.article || 'der');
            document.getElementById('word-de').value = w.word_de; document.getElementById('word-ru').value = w.word_ru; checkDuplicate();
            document.getElementById('word-plural').value = w.plural || ""; document.getElementById('word-praeteritum').value = w.praeteritum || "";
            document.getElementById('word-partizip').value = w.partizip || ""; document.getElementById('word-example').value = w.example || "";
            document.getElementById('word-folder').value = w.folder; document.getElementById('word-level').value = w.level || ""; document.getElementById('word-subfolder').value = w.subfolder;
            modal.classList.remove('hidden');
        };

        function checkDuplicate() {
            const val = document.getElementById('word-de').value.trim().toLowerCase();
            const warning = document.getElementById('duplicate-warning');
            if (!val) { warning.classList.add('hidden'); return; }

            const duplicateWord = globalWords.find(w => w.word_de.toLowerCase() === val && (!editId || w.id !== editId));
            if (duplicateWord) {
                const iconSVG = `<svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>`;
                warning.innerHTML = `${iconSVG}<span>Уже есть: <b>${duplicateWord.word_ru}</b> (Курс: ${duplicateWord.folder} / ${duplicateWord.subfolder})</span>`;
                warning.classList.remove('hidden');
            } else {
                warning.classList.add('hidden');
            }
        }

        document.getElementById('word-de').addEventListener('input', checkDuplicate);

        // --- АВТОМАТИЧЕСКИЙ ПЕРЕВОД И ПОДСТАНОВКА АРТИКЛЕЙ ---
        async function autoTranslate(sourceInput, targetInput, isSourceRu) {
            const query = sourceInput.value.trim();
            if (!query) return;
            // Если целевое поле уже заполнено - не перезаписываем (уважаем ручной ввод)
            if (targetInput.value.trim().length > 0) return;

            const loaderId = isSourceRu ? 'translate-loader-de' : 'translate-loader-ru';
            const loader = document.getElementById(loaderId);
            if (loader) loader.classList.remove('hidden');

            try {
                // Прямой перевод через Google Translate (неофициальный, но работающий endpoint)
                const sl = isSourceRu ? 'ru' : currentStudyLang;
                const tl = isSourceRu ? currentStudyLang : 'ru';
                const translateUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(query)}`;

                const res = await fetch(translateUrl);
                const data = await res.json();
                let translated = data[0][0][0];
                targetInput.value = translated;

                // Если мы перевели на немецкий (или с немецкого), попытаемся узнать род и множественное число
                let deWord = isSourceRu ? translated : query;
                if (deWord) {
                    try {
                        const wikUrl = `https://de.wiktionary.org/w/api.php?origin=*&action=query&prop=revisions&rvprop=content&titles=${encodeURIComponent(deWord)}&format=json`;
                        const wikRes = await fetch(wikUrl, { headers: { 'User-Agent': 'OsmanovDictTool/1.0 (osmanov@example.com)' } });
                        const wikData = await wikRes.json();
                        const pages = wikData.query.pages;
                        const pageId = Object.keys(pages)[0];

                        // По умолчанию ставим der, если не найдем ничего
                        let genus = 'der';
                        let plural = '';

                        if (pageId !== '-1') {
                            const content = pages[pageId].revisions[0]['*'];

                            // 1. Ищем род (Genus)
                            const genusMatch = content.match(/\{\{Genus\|([mfn])\}\}/) || content.match(/\{\{([mfn])\}\}/);
                            if (genusMatch) {
                                const g = genusMatch[1];
                                if (g === 'm') genus = 'der';
                                else if (g === 'f') genus = 'die';
                                else if (g === 'n') genus = 'das';
                            } else {
                                if (content.includes('{{m}}')) genus = 'der';
                                else if (content.includes('{{f}}')) genus = 'die';
                                else if (content.includes('{{n}}')) genus = 'das';
                                else if (deWord.endsWith('chen') || deWord.endsWith('lein') || deWord.endsWith('ment') || deWord.endsWith('um')) genus = 'das';
                                else if (deWord.endsWith('ung') || deWord.endsWith('keit') || deWord.endsWith('heit') || deWord.endsWith('schaft') || deWord.endsWith('tion') || deWord.endsWith('tät') || deWord.endsWith('ik') || deWord.endsWith('ie') || deWord.endsWith('ur') || deWord.endsWith('enz') || deWord.endsWith('anz')) genus = 'die';
                                else if (deWord.endsWith('er') || deWord.endsWith('ig') || deWord.endsWith('ling') || deWord.endsWith('ismus')) genus = 'der';
                            }
                            selectArticle(genus);

                            // 2. Ищем множественное число (Plural)
                            const pMatch = content.match(/Nominativ Plural\s*=\s*([^<\n\|\}]+)/);
                            if (pMatch) {
                                plural = pMatch[1].trim();
                                if (plural.startsWith('die ')) plural = plural.substring(4);
                                const pluralInput = document.getElementById('word-plural');
                                if (pluralInput && !pluralInput.value) {
                                    pluralInput.value = plural;
                                }
                            }

                            // 3. Ищем формы глаголов (Präteritum, Partizip II)
                            const praetMatch = content.match(/Präteritum_ich=([^<\n\|\}]+)/);
                            const partMatch = content.match(/Partizip II=([^<\n\|\}]+)/);

                            if (praetMatch || partMatch) {
                                // Это глагол!
                                setType('verb');
                                if (praetMatch) {
                                    const praetInput = document.getElementById('word-praeteritum');
                                    if (praetInput && !praetInput.value) praetInput.value = praetMatch[1].trim();
                                }
                                if (partMatch) {
                                    const partInput = document.getElementById('word-partizip');
                                    if (partInput && !partInput.value) partInput.value = partMatch[1].trim();
                                }
                            } else {
                                // Если нет форм глагола, то скорее всего это существительное или др. оставим noun
                                setType('noun');
                                selectArticle(genus);
                            }

                            // 4. Пытаемся вытащить пример использования (Beispiel)
                            const examplesBlock = content.split('{{Beispiele}}')[1] || content.split('==== Beispiele ====\n')[1];
                            if (examplesBlock) {
                                const lines = examplesBlock.split('\n');
                                for (let line of lines) {
                                    if (line.match(/^:\[\d+\]\s/)) {
                                        let text = line.replace(/^:\[\d+\]\s*/, '');
                                        text = text.replace(/\{\{[^}]+\}\}/g, '').trim();
                                        text = text.replace(/'''/g, '');
                                        text = text.replace(/''/g, '');
                                        text = text.replace(/<ref.*?<\/ref>/g, '');
                                        const exampleInput = document.getElementById('word-example');
                                        if (exampleInput && !exampleInput.value) exampleInput.value = text.trim();
                                        break;
                                    }
                                    if (line.includes('{{Wortbildung}}') || line.includes('{{Übersetzungen}}')) break;
                                }
                            }
                        }
                    } catch (e) { console.log('Wiktionary error', e); }
                }

                checkDuplicate(); // Обновим проверку дубликатов
            } catch (err) {
                console.error("Translation error:", err);
            } finally {
                if (loader) loader.classList.add('hidden');
            }
        }

        document.getElementById('word-ru').addEventListener('blur', () => {
            autoTranslate(document.getElementById('word-ru'), document.getElementById('word-de'), true);
        });

        document.getElementById('word-de').addEventListener('blur', () => {
            autoTranslate(document.getElementById('word-de'), document.getElementById('word-ru'), false);
        });

        window.fastAdd = (folder, level, subfolder) => {
            editId = null; document.getElementById('modal-title').innerText = "Быстрое добавление"; document.getElementById('add-form').reset(); setType('noun'); showSingleTab(); selectArticle('der');
            checkDuplicate();
            const lvl = level === 'Общее' ? '' : level;
            document.getElementById('word-folder').value = folder; document.getElementById('word-level').value = lvl; document.getElementById('word-subfolder').value = subfolder;
            document.getElementById('bulk-folder').value = folder; document.getElementById('bulk-level').value = lvl; document.getElementById('bulk-subfolder').value = subfolder;
            modal.classList.remove('hidden'); setTimeout(() => document.getElementById('word-de').focus(), 150);
        };

        window.fastAddCourse = (folder) => {
            editId = null; document.getElementById('modal-title').innerText = "Добавить тему / слова"; document.getElementById('add-form').reset(); setType('noun'); showSingleTab(); selectArticle('der');
            checkDuplicate();
            document.getElementById('word-folder').value = folder; document.getElementById('word-level').value = ''; document.getElementById('word-subfolder').value = '';
            document.getElementById('bulk-folder').value = folder; document.getElementById('bulk-level').value = ''; document.getElementById('bulk-subfolder').value = '';
            modal.classList.remove('hidden'); setTimeout(() => document.getElementById('word-subfolder').focus(), 150);
        };

        window.deleteWord = async (id, event) => {
            if (event) event.stopPropagation();
            premiumConfirm(t('Удалить слово навсегда?'), async () => {
                await apiFetch(`${API_URL}/${id}`, { method: 'DELETE' });
                await fetchWords(); renderDict();
            });
        };

        window.deleteFolder = async (f, l, s) => {
            try {
                await apiFetch('/words/delete_folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: f, level: l, subfolder: s }) });
                await fetchWords(); renderDict();
            } catch (e) { alert(t('Ошибка сети!')); }
        };

        window.deleteCourse = async (f) => {
            try {
                await apiFetch('/words/delete_course', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: f }) });
                await fetchWords(); renderDict();
            } catch (e) { alert(t('Ошибка сети!')); }
        };

        window.deleteLevel = async (f, l) => {
            try {
                await apiFetch('/words/delete_level', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: f, level: l }) });
                await fetchWords(); renderDict();
            } catch (e) { alert(t('Ошибка сети!')); }
        };

        window.renameLevel = async (f, oldL, newL) => {
            try {
                await apiFetch('/words/rename_level', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: f, old_level: oldL, new_level: newL }) });
                await fetchWords(); renderDict();
            } catch (e) { alert(t('Ошибка сети!')); }
        };

        window.manageLevel = (f, l, event) => {
            if (!isDevMode) return;
            event.stopPropagation();
            const action = prompt(`Уровень: ${l}\n\nВведите новое название для переименования, или введите "DELETE" (заглавными) для полного удаления всех слов этого уровня.`);
            if (action === 'DELETE') {
                premiumConfirm(t('Удалить уровень со всеми словами внутри?'), () => deleteLevel(f, l));
            } else if (action && action.trim() !== '' && action !== l) {
                renameLevel(f, l, action.trim());
            }
        };

        let _formSubmitting = false;
        document.getElementById('add-form').onsubmit = async (e) => {
            e.preventDefault();
            if (_formSubmitting) return; // Prevent double submission
            _formSubmitting = true;
            const saveBtn = document.getElementById('btn-save');
            // Disable immediately and synchronously before any await
            if (saveBtn) { saveBtn.disabled = true; saveBtn.style.opacity = '0.6'; saveBtn.innerText = 'Сохраняю...'; }
            try {
                const payload = {
                    word_type: currentType, article: currentType === 'noun' ? currentArticle : '',
                    word_de: document.getElementById('word-de').value.trim(), plural: currentType === 'noun' ? document.getElementById('word-plural').value.trim() : '',
                    praeteritum: currentType === 'verb' ? document.getElementById('word-praeteritum').value.trim() : '', partizip: currentType === 'verb' ? document.getElementById('word-partizip').value.trim() : '',
                    word_ru: document.getElementById('word-ru').value.trim(), example: document.getElementById('word-example').value.trim(), example_ru: "",
                    folder: document.getElementById('word-folder').value.trim(), level: document.getElementById('word-level').value.trim(), subfolder: document.getElementById('word-subfolder').value.trim(),
                    target_lang: currentStudyLang
                };
                const url = editId ? `${API_URL}/${editId}/full` : API_URL;
                await apiFetch(url, { method: editId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                modal.classList.add('hidden'); searchInp.value = '';
                const newTopicKey = `${payload.folder}|${payload.level || 'Общее'}|${payload.subfolder}`; collapsedDictTopics[newTopicKey] = false;
                await fetchWords(); renderDict();
            } finally {
                _formSubmitting = false;
                if (saveBtn) { saveBtn.disabled = false; saveBtn.style.opacity = ''; saveBtn.innerText = editId ? 'Сохранить' : 'Сохранить'; }
            }
        };

        document.getElementById('btn-upload-csv').onclick = async () => {
            const f = new FormData();
            const folder = document.getElementById('bulk-folder').value.trim(); const level = document.getElementById('bulk-level').value.trim(); const subfolder = document.getElementById('bulk-subfolder').value.trim(); const fileInput = document.getElementById('bulk-file');
            if (!folder || !subfolder || !fileInput.files[0]) return alert(t("Заполните курс, тему и выберите файл!"));
            f.append('folder', folder); f.append('level', level); f.append('subfolder', subfolder); f.append('file', fileInput.files[0]); f.append('target_lang', currentStudyLang);
            const btn = document.getElementById('btn-upload-csv'); btn.innerHTML = 'Загрузка...'; btn.disabled = true;
            try {
                await apiFetch('/upload_csv', { method: 'POST', body: f }); modal.classList.add('hidden');
                const newTopicKey = `${folder}|${level || 'Общее'}|${subfolder}`; collapsedDictTopics[newTopicKey] = false;
                await fetchWords(); renderDict();
            } catch (e) { alert(t("Ошибка загрузки!")); }
            finally { btn.innerHTML = 'Загрузить слова'; btn.disabled = false; }
        };

        document.getElementById('bulk-file').onchange = function () {
            const label = document.getElementById('bulk-file-label');
            if (this.files[0]) label.innerText = this.files[0].name; else label.innerText = 'Выбрать CSV файл';
        };

        window.exportData = async () => {
            const btn = document.getElementById('btn-trigger-export');
            const prevText = btn.innerHTML;
            btn.innerHTML = 'Подготовка...'; btn.disabled = true;
            try {
                const res = await apiFetch(`/export_csv`);
                const blob = await res.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a'); a.href = url; a.download = `backup_${currentUser}.csv`;
                document.body.appendChild(a); a.click(); a.remove();
            } catch (e) { alert(t("Ошибка выгрузки!")); }
            finally { btn.innerHTML = prevText; btn.disabled = false; }
        };

        document.getElementById('file-restore').onchange = async function () {
            if (!this.files[0]) return;
            const btn = document.getElementById('btn-trigger-restore');
            btn.innerHTML = 'Восстановление...'; btn.disabled = true;
            const f = new FormData(); f.append('file', this.files[0]);
            try {
                await apiFetch('/restore_backup', { method: 'POST', body: f });
                document.getElementById('backup-modal').classList.add('hidden');
                await fetchWords(); renderDict(); switchView('dict');
            } catch (e) { alert(t("Ошибка восстановления!")); }
            finally { btn.innerHTML = 'Восстановить из файла'; btn.disabled = false; this.value = ''; }
        };

        let trainList = []; let curIdx = 0; let cardTimeout = null;

        window.currentTrainingMode = localStorage.getItem('kraft_train_mode') || 'classic';
        if (window.currentTrainingMode === 'listening' || window.currentTrainingMode === 'context') window.currentTrainingMode = 'classic';
        
        window.setTrainingMode = function(mode) {
            window.currentTrainingMode = mode;
            localStorage.setItem('kraft_train_mode', mode);
            setupTrainMenu();
        };

        window.setDirection = (dir) => {
            trainDirection = dir;
            const activeCls = "flex-1 py-2 text-[10px] font-bold rounded-lg bg-[#2A3B5E] text-[#D4AF37] shadow-sm transition-all uppercase";
            const inactiveCls = "flex-1 py-2 text-[10px] font-bold rounded-lg text-gray-500 transition-all uppercase hover:text-gray-700 dark:hover:text-[#D4AF37]";
            document.getElementById('add-btn').outerHTML = `<button id="add-btn" class="bg-[#0b101e] text-yellow-500 w-10 h-10 rounded-full flex items-center justify-center hover:scale-110 active:scale-95 transition-all duration-300 text-xl font-black border border-yellow-500/40 hover:shadow-[0_0_15px_rgba(234,179,8,0.35)] hover:border-yellow-500/70">+</button>`;
            document.getElementById('dir-auto').className = dir === 'auto' ? activeCls : inactiveCls;
            document.getElementById('dir-ru-de').className = dir === 'ru-de' ? activeCls : inactiveCls;
            document.getElementById('dir-de-ru').className = dir === 'de-ru' ? activeCls : inactiveCls;
        };

        function setupTrainMenu() {
            const container = document.getElementById('train-topics-container');
            const verbGame = document.getElementById('verb-trainer-game');
            if (verbGame) verbGame.classList.add('hidden');
            if (container && container.parentElement) container.parentElement.classList.remove('hidden');
            if (document.getElementById('train-card-block')) document.getElementById('train-card-block').classList.add('hidden');
            try {
                container.innerHTML = '';
                let eligibleWords = globalWords;
                // Only normal filtering


                const availableCount = eligibleWords.filter(w => isWordDue(w)).length;
                const masteredCount = eligibleWords.filter(w => w.score >= MAX_SCORE).length;
                const waitingCount = eligibleWords.filter(w => !isWordDue(w)).length;
                const weakWordsCount = eligibleWords.filter(w => w.score < 2 && isWordDue(w)).length;

                const verbAvailableCount = globalWords.filter(w => w.word_type === 'verb' && w.praeteritum && w.partizip).length;

                    <button onclick="startTraining('all')" class="w-full text-left bg-[#172A45] border border-[#D4AF37]/30 hover:scale-[0.98] transition-all p-5 rounded-2xl shadow-md text-white flex justify-between items-center group mb-3 relative overflow-hidden">
                        <div class="absolute inset-0 bg-gradient-to-r from-[#D4AF37]/5 to-transparent pointer-events-none"></div>
                        <div class="relative z-10 w-full pr-4">
                            <h3 class="text-lg font-bold">${t('Слова на сегодня')}</h3>
                            <p class="text-gray-400 text-[11px] font-medium mt-1 mb-3"><span class="notranslate">${t('Доступно:')}</span> <span class="text-white font-bold">${availableCount}</span> ${waitingCount > 0 ? `<span class="opacity-30 mx-1">|</span> <span class="notranslate">${t('Ожидают:')}</span> <span class="text-gray-600 font-bold">${waitingCount}</span>` : ''}</p>
                            <div class="w-full">
                                <p class="text-[10px] uppercase font-black text-[#D4AF37] tracking-wider mb-1.5 drop-shadow-sm">Дейлик: ${availableCount} / 200 слов</p>
                                <div class="w-full h-1.5 bg-black/40 rounded-full overflow-hidden border border-white/5 shadow-inner">
                                    <div class="h-full bg-gradient-to-r from-yellow-600 to-yellow-400 shadow-[0_0_8px_rgba(234,179,8,0.5)]" style="width: ${Math.min((availableCount/200)*100, 100)}%"></div>
                                </div>
                            </div>
                        </div>
                        <div class="bg-[#112240] backdrop-blur-md bg-opacity-80/20 w-8 h-8 rounded-full flex items-center justify-center backdrop-blur-sm relative z-10 flex-shrink-0"><svg class="w-4 h-4 text-[#D4AF37]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg></div>
                    </button>
                    ${currentStudyLang === 'de' && window.currentTrainingMode === 'classic' ? `
                    <button onclick="startVerbTrainer()" class="w-full text-left bg-[#172A45] hover:scale-[0.98] transition-all p-4 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 flex justify-between items-center group mb-3">
                        <div>
                            <h3 class="text-sm font-bold text-white flex items-center gap-2">${t('Формы глаголов')}</h3>
                            <p class="text-gray-500 text-[10px] font-medium mt-0.5">${t('Тренировка Präteritum и Partizip II')}: <span class="notranslate">${verbAvailableCount}</span></p>
                        </div>
                        <div class="text-[#D4AF37]"><svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg></div>
                    </button>` : ''}
                `;

                if (weakWordsCount > 0) {
                    html += `
                        <button onclick="startTraining('weak')" class="w-full text-left bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800/50 hover:scale-[0.98] transition-all p-4 rounded-xl flex justify-between items-center group mb-3">
                            <div>
                                <h3 class="text-orange-700 dark:text-orange-400 text-sm font-bold">${t('Слабые места')}</h3>
                                <p class="text-gray-600 text-[10px] font-medium mt-0.5"><span class="notranslate">${t('Новые или забытые:')}</span> ${weakWordsCount}</p>
                            </div>
                            <div class="text-orange-400"><svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg></div>
                        </button>
                    `;
                }

                if (masteredCount > 0) {
                    html += `
                        <button onclick="startTraining('mastered')" class="w-full text-left bg-[#172A45] dark:bg-[#172A45] hover:scale-[0.98] transition-all p-4 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 flex justify-between items-center group mb-3">
                            <div>
                                <h3 class="text-sm font-bold text-white flex items-center gap-2"> ${t('Повторить архив')}</h3>
                                <p class="text-gray-600 text-[10px] font-medium mt-0.5"><span class="notranslate">${t('Изучено:')}</span> ${masteredCount}</p>
                            </div>
                            <div class="text-gray-500"><svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg></div>
                        </button>
                    `;
                }

                const groupedTopics = {};
                globalWords.forEach(w => {
                    const f = w.folder || 'Без курса'; const key = `${w.folder}|${w.level || 'Общее'}|${w.subfolder}`;
                    if (!groupedTopics[f]) groupedTopics[f] = new Set(); groupedTopics[f].add(key);
                });

                let savedFolderOrder = [];
                try { savedFolderOrder = JSON.parse(localStorage.getItem('folderOrder')) || []; } catch (e) { }
                const folderNames = Object.keys(groupedTopics).sort((a, b) => { let idxA = savedFolderOrder.indexOf(a); let idxB = savedFolderOrder.indexOf(b); if (idxA === -1) idxA = 9999; if (idxB === -1) idxB = 9999; return idxA - idxB; });

                const activeTopicsHTML = []; const masteredTopicsHTML = [];

                for (const folder of folderNames) {
                    const courseWords = globalWords.filter(w => (w.folder || 'Без курса') === folder);
                    const cWordsCount = courseWords.filter(w => isWordDue(w)).length;
                    const folderId = `train-f-${btoa(encodeURIComponent(folder)).replace(/=/g, '')}`;
                    // Folders collapsed by default unless explicitly opened in localStorage
                    const isOpen = localStorage.getItem(folderId) === 'true' ? 'open' : '';

                    let folderActiveHTML = '';
                    let hasActive = false;
                    let topicsHTML = '';

                    groupedTopics[folder].forEach(topicKey => {
                        const [f, l, s] = topicKey.split('|');
                        const allInTopic = globalWords.filter(w => w.folder === f && (w.level || 'Общее') === l && w.subfolder === s);
                        const wordsCount = allInTopic.filter(w => isWordDue(w)).length;
                        const waitingCount = allInTopic.filter(w => !isWordDue(w)).length;

                        if (wordsCount > 0 || waitingCount > 0) {
                            hasActive = true;
                            topicsHTML += `
                                <button onclick="startTraining('${escapeStr(topicKey)}')" class="w-[calc(100%-12px)] mx-auto ml-1.5 text-left bg-[#112240] backdrop-blur-md bg-opacity-80 dark:bg-[#233554] hover:bg-[#2A3B5E] transition-all p-2.5 rounded-lg flex justify-between items-center group mb-1">
                                    <div>
                                        <div class="flex items-center gap-2 mb-0.5">
                                            ${l !== 'Общее' ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-md ${getLevelColor(l)}">${l}</span>` : ''}
                                            <h3 class="text-sm font-medium text-gray-100 dark:text-gray-100 notranslate">${s}</h3>
                                        </div>
                                        <p class="text-[11px] text-gray-500"><span class="notranslate">${t('Доступно:')}</span> ${wordsCount} <span class="opacity-60">${waitingCount > 0 ? `| <span class="notranslate">${t('Ожидают:')}</span> ${waitingCount}` : ''}</span></p>
                                    </div>
                                    <div class="text-[#D4AF37] opacity-0 group-hover:opacity-100 transition-opacity"><svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg></div>
                                </button>
                            `;
                        }
                    });

                    if (hasActive || cWordsCount > 0) {
                        folderActiveHTML += `
                            <div class="mb-2 bg-[#172A45] dark:bg-[#172A45] rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
                                <div class="flex justify-between items-center p-4">
                                    <h3 class="text-sm font-bold text-white notranslate">${folder}</h3>
                                    <span class="text-[11px] text-gray-500 font-medium"><span class="notranslate">${t('Доступно:')}</span> ${cWordsCount}</span>
                                </div>
                                <div class="px-3 pb-3">
                                    <button onclick="startTraining('course|${escapeStr(folder)}')" class="w-full text-left bg-blue-900/20 hover:bg-blue-900/40 transition-all p-3 rounded-lg border border-blue-800/50 flex justify-between items-center group mb-2">
                                        <h3 class="text-sm font-bold text-blue-400"><span class="notranslate">${t('Тренировать весь курс')}</span></h3>
                                        <div class="text-blue-400"><svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"/></svg></div>
                                    </button>
                                    ${topicsHTML ? `
                                    <details id="${folderId}" ontoggle="localStorage.setItem('${folderId}', this.open)" class="group" ${isOpen}>
                                        <summary class="flex items-center gap-2 cursor-pointer outline-none select-none list-none text-[10px] font-bold text-gray-500 uppercase tracking-wider hover:text-gray-300 transition-colors mb-2">
                                            ${t('Темы')}
                                            <svg class="w-3 h-3 transition-transform duration-300 transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7 7"/></svg>
                                        </summary>
                                        <div class="space-y-1 relative pl-1 border-l-2 border-white/5">
                                            ${topicsHTML}
                                        </div>
                                    </details>
                                    ` : ''}
                                </div>
                            </div>
                        `;
                        activeTopicsHTML.push(folderActiveHTML);
                    }
                }

                container.innerHTML = html + activeTopicsHTML.join('');
                // Instantly translate all dynamically injected text
                if (typeof translateNode === 'function') translateNode(container);
                document.getElementById('train-setup-block').classList.remove('hidden'); document.getElementById('train-card-block').classList.add('hidden');
            } catch (err) {
                console.error("Error in setupTrainMenu:", err);
            }
        }

        window.startTraining = (sel, forceArchive = false) => {
            let eligibleWords = globalWords;
            // Only normal filtering
            
            let availableWords = eligibleWords.filter(w => isWordDue(w));

            if (sel === 'all') { trainList = availableWords; }
            else if (sel === 'weak') { trainList = availableWords.filter(w => w.score < 2); }
            else if (sel.startsWith('course|')) { const courseName = sel.split('|')[1]; trainList = availableWords.filter(w => (w.folder || 'Без курса') === courseName); }
            else if (sel === 'mastered' || forceArchive) {
                if (forceArchive) { const [f, l, s] = sel.split('|'); trainList = eligibleWords.filter(w => w.folder === f && (w.level || 'Общее') === l && w.subfolder === s); }
                else { trainList = eligibleWords.filter(w => w.score >= MAX_SCORE); }
            }
            else { const [f, l, s] = sel.split('|'); trainList = availableWords.filter(w => w.folder === f && (w.level || 'Общее') === l && w.subfolder === s); }

            if (!trainList.length) return alert(t('На сегодня слов нет! Отдыхай.'));
            trainList.sort(() => 0.5 - Math.random()); curIdx = 0; sessionStartMs = Date.now();
            document.getElementById('train-setup-block').classList.add('hidden'); document.getElementById('train-card-block').classList.remove('hidden');
            const nav = document.getElementById('bottom-nav'); if (nav) nav.classList.add('hidden');
            const pnl = document.getElementById('train-xp-panel'); if (pnl) { pnl.style.display = 'flex'; } renderCard();
        };

        document.getElementById('btn-stop-training').onclick = () => {
            const pnl = document.getElementById('train-xp-panel'); if (pnl) pnl.style.display = 'none';
            const nav = document.getElementById('bottom-nav'); if (nav) nav.classList.remove('hidden');
            if (cardTimeout) clearTimeout(cardTimeout);
            saveSessionTime(); setupTrainMenu();
        };

        function renderCard() {
            const cardBlock = document.getElementById('train-card-block');
            cardBlock.classList.remove('animate-fold-up');
            // If card was hidden by swipe, keep it invisible during content swap
            // and fade it in after rendering is complete
            const needsFadeIn = (cardBlock.style.opacity === '0');

            if (curIdx >= trainList.length) {
                if (window.confetti) confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
                const nav = document.getElementById('bottom-nav'); if (nav) nav.classList.remove('hidden');
                saveSessionTime(); document.getElementById('main-scroll').scrollTo({ top: 0, behavior: 'smooth' }); setupTrainMenu(); return;
            }

            const w = trainList[curIdx];
            const qEl = document.getElementById('train-question'); const exQ = document.getElementById('train-example-q'); const badge = document.getElementById('train-level-badge');

            document.getElementById('train-total-cards').innerText = trainList.length - curIdx;
            // Progress dots instead of text label
            const progressDots = Array.from({ length: MAX_SCORE }, (_, i) => i < Math.min(w.score, MAX_SCORE) ? '●' : '○').join('');
            document.getElementById('train-card-progress-text').innerText = progressDots;
            document.getElementById('train-card-progress-fill').style.width = `${Math.min(100, (w.score / MAX_SCORE) * 100)}%`;

            document.getElementById('train-answer-block').classList.add('hidden');
            document.getElementById('btn-show-answer').classList.add('hidden');
            document.getElementById('train-de-plural').classList.add('hidden');
            const typingBlock = document.getElementById('train-typing-block');
            if (typingBlock) typingBlock.classList.add('hidden');

            // Set remaining label using t() to correctly translate
            const remLabel = document.getElementById('train-remaining-label');
            if (remLabel) remLabel.innerText = t('Осталось:');
            if (exQ) {
                exQ.classList.add('hidden');
                exQ.className = "text-sm text-[#D4AF37] dark:text-[#FDE08B] italic mb-5 hidden text-center w-full";
            }

            const btnSpeakQ = document.getElementById('btn-speak-question'); const btnSpeakAns = document.getElementById('btn-speak-answer');

            const fullGerman = (w.word_type === 'noun' ? (w.article || '') + ' ' : '') + (w.word_de || '');
            let state = w.score < (MAX_SCORE - 1) ? 'L1' : w.score < MAX_SCORE ? 'L2' : 'Archive';

            document.getElementById('train-de-word').innerText = fullGerman;
            if (w.word_type === 'noun' && w.plural) document.getElementById('train-de-plural').innerHTML = `<span class="opacity-60 text-sm"><span class="font-bold mr-1 notranslate">Pl.:</span><span class="font-medium mr-1 notranslate">die</span><span class="notranslate">${escapeStr(w.plural)}</span></span>`;
            else if (w.word_type === 'verb' && (w.praeteritum || w.partizip)) {
                const seinVerbs = ['gehen', 'fahren', 'laufen', 'fliegen', 'kommen', 'ankommen', 'werden', 'sein', 'bleiben', 'passieren', 'fallen', 'steigen', 'aufstehen', 'einschlafen', 'aufwachen', 'wachsen', 'entstehen', 'sterben'];
                const inf = (w.word_de || '').toLowerCase();
                const rawPartizipLower = (w.partizip || '').toLowerCase().trim();
                const alreadyHasAux = rawPartizipLower.startsWith('hat ') || rawPartizipLower.startsWith('ist ') || rawPartizipLower.startsWith('haben ') || rawPartizipLower.startsWith('sein ');
                const aux = seinVerbs.some(v => inf.includes(v)) ? 'ist' : 'hat';
                const partizipDisplay = w.partizip
                    ? (alreadyHasAux
                        ? escapeStr(w.partizip)
                        : `<span class="text-gray-500 text-[9px] mr-1">${aux}</span>${escapeStr(w.partizip)}`)
                    : '-';
                document.getElementById('train-de-plural').innerHTML = `<span class="text-gray-400 notranslate">${escapeStr(w.praeteritum) || '-'}</span><span class="text-gray-600 mx-2">·</span><span class="text-gray-400 notranslate">${partizipDisplay}</span>`;
            }

            if (window.currentTrainingMode === 'blitz') {
                if (qEl) qEl.innerHTML = (w.word_de || '') + `<br><span class="text-sm font-normal text-gray-500 mt-2 block">${escapeStr(w.word_ru || '')}</span>`;
                document.getElementById('train-blitz-block').classList.remove('hidden');
                if (btnSpeakQ) btnSpeakQ.classList.add('hidden');
                if (btnSpeakAns) btnSpeakAns.classList.add('hidden');
                if (badge) { badge.innerText = "Артикли"; badge.className = "px-2.5 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-widest bg-blue-50 dark:bg-blue-900/30 text-[#AA7C11] dark:text-[#FDE08B]"; }
            } else {
                if (trainDirection === 'de-ru') currentIsGermanQuestion = true;
                else if (trainDirection === 'ru-de') currentIsGermanQuestion = false;
                else currentIsGermanQuestion = state === 'L2' ? false : Math.random() > 0.5;

                if (currentIsGermanQuestion) {
                    if (btnSpeakQ) { btnSpeakQ.classList.remove('hidden'); btnSpeakQ.onclick = (e) => speakWord(fullGerman, e); }
                    if (btnSpeakAns) btnSpeakAns.classList.add('hidden');
                    setTimeout(() => speakWord(fullGerman), 100);
                } else {
                    if (btnSpeakQ) btnSpeakQ.classList.add('hidden');
                    if (btnSpeakAns) { btnSpeakAns.classList.remove('hidden'); btnSpeakAns.onclick = (e) => speakWord(fullGerman, e); }
                }

                const ansEx = document.getElementById('train-answer-example');
                if (w.example && ansEx) {
                    const sentence = extractGermanSentence(w.example);
                    const safeSentence = escapeStr(sentence);
                    ansEx.innerHTML = `
                        <div class="flex items-center justify-center gap-2">
                            <span class="italic text-center">"${sentence}"</span>
                            <button onclick="speakWord('${safeSentence}', event)" class="p-1.5 bg-[#112240] rounded-full text-gray-400 hover:text-[#D4AF37] transition-all flex-shrink-0 border border-gray-700 shadow-sm" title="Прослушать пример">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5 10v4a2 2 0 002 2h2l4 4V4L9 8H7a2 2 0 00-2 2z"></path></svg>
                            </button>
                        </div>
                    `;
                    ansEx.classList.remove('hidden');
                } else if (ansEx) ansEx.classList.add('hidden');

                document.getElementById('train-de-word').innerText = currentIsGermanQuestion ? (w.word_ru || '') : fullGerman;

                if (state === 'L1' || state === 'L2' || state === 'Archive') {
                    if (badge) {
                        if (state === 'Archive') { badge.innerText = t("Архив"); badge.className = "px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest bg-[#112240] dark:bg-[#172A45] text-gray-500"; }
                        else {
                            const typeLabel = w.word_type === 'verb' ? (currentStudyLang === 'de' ? 'Verb' : t('Глагол')) : (w.word_type === 'noun' ? (currentStudyLang === 'de' ? 'Nomen' : t('Существительное')) : '');
                            badge.innerText = typeLabel || '';
                            badge.className = typeLabel ? "px-2.5 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-widest bg-blue-50 dark:bg-blue-900/30 text-[#AA7C11] dark:text-[#FDE08B]" : "hidden";
                        }
                    }
                    if (qEl) qEl.innerText = currentIsGermanQuestion ? fullGerman : (w.word_ru || '');
                    document.getElementById('btn-show-answer').classList.remove('hidden');

                    document.getElementById('btn-forgot').onclick = () => { triggerVibration([10, 20]); playTone(200, 'sawtooth', 0.2); updateScoreWithSM2(0); };
                    document.getElementById('btn-remembered').onclick = () => { triggerVibration(10); playTone(800, 'sine', 0.3); updateScoreWithSM2(4); };

                    const goodCalc = calculateSRS(4, w.score, w.interval);
                    const sm2El = document.getElementById('sm2-good-time');
                    if (sm2El) { sm2El.innerText = formatInterval(goodCalc.newInterval); sm2El._interval = goodCalc.newInterval; }
                }
            }
            // Instantly translate any UI labels in the card (don't wait for MutationObserver)
            if (typeof translateNode === 'function') translateNode(cardBlock);
            // Fade card in smoothly if it was hidden by a swipe
            if (needsFadeIn) {
                requestAnimationFrame(() => {
                    cardBlock.style.transition = 'opacity 0.18s ease-out';
                    cardBlock.style.opacity = '1';
                    setTimeout(() => {
                        cardBlock.style.opacity = '';
                        cardBlock.style.transition = '';
                    }, 200);
                });
            }
        }

        let _swipeInProgress = false;

        let _toastTimeout;
        window.showPremiumToast = function(msg) {
            const toast = document.getElementById('premium-toast');
            document.getElementById('toast-msg').innerHTML = msg;
            toast.classList.remove('scale-95', 'opacity-0');
            toast.classList.add('scale-100', 'opacity-100');
            clearTimeout(_toastTimeout);
            _toastTimeout = setTimeout(() => {
                toast.classList.remove('scale-100', 'opacity-100');
                toast.classList.add('scale-95', 'opacity-0');
            }, 3000);
        };

        let _isScoring = false;
        async function updateScoreWithSM2(quality) {
            if (_isScoring) return;
            const w = trainList[curIdx];
            if (!w) return;
            _isScoring = true;

            try {
                const cardBlock = document.getElementById('train-card-block');
                if (!_swipeInProgress) {
                    cardBlock.classList.add('animate-fold-up');
                }

                // New SRS logic
                const srsResult = calculateSRS(quality, w.score, w.interval);
                const { newScore, newInterval } = srsResult;

                let nextReviewMs;
                if (newInterval === 0) {
                    // Fail or new word — return to session in 10 min
                    nextReviewMs = Date.now() + 10 * 60 * 1000;
                } else {
                    nextReviewMs = Date.now() + newInterval * 24 * 60 * 60 * 1000;
                }

                // Fail: push word back into session queue with updated score
                if (quality < 3) {
                    trainList.push({ ...w, score: newScore, interval: newInterval, next_review: nextReviewMs });
                }

                w.score = newScore;
                w.next_review = nextReviewMs;
                w.interval = newInterval;
                // keep ease_factor/repetitions for legacy DB compat
                w.repetitions = newScore;

                // Fire XP — only on success
                if (quality >= 3) {
                    updateDailyActivity(newScore === 1, window.innerWidth / 2, window.innerHeight / 2 - 100);
                } else {
                    updateExperience();
                }

                try {
                    apiFetch(`${API_URL}/${w.id}/score`, {
                        method: 'PUT', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            score: newScore,
                            next_review: nextReviewMs,
                            ease_factor: w.ease_factor || 2.5,
                            interval: newInterval,
                            repetitions: newScore
                        })
                    }).catch(e => {}); // Do not await
                } catch (e) { }

                const gwItem = globalWords.find(gw => gw.id === w.id);
                if (gwItem && gwItem !== w) {
                    gwItem.score = newScore;
                    gwItem.next_review = nextReviewMs;
                    gwItem.interval = newInterval;
                    gwItem.repetitions = newScore;
                }

                idbSaveWords(globalWords); // Persist to IndexedDB immediately for offline reliability
                updateExperience();
                curIdx++; _swipeInProgress = false;
                setTimeout(() => {
                    try { renderCard(); } catch (e) { console.error(e); } finally { _isScoring = false; }
                }, 250);
            } catch (err) {
                console.error("SRS critical:", err);
                _isScoring = false;
                _swipeInProgress = false;
            }
        }

        let _isFlipping = false;
        document.getElementById('btn-show-answer').onclick = () => {
            if (_isFlipping) return;
            _isFlipping = true;
            try {
                triggerVibration(15);
                const card = document.getElementById('train-card-block');
                card.classList.add('perspective-1000', 'transform-style-3d');
                card.style.transform = 'rotateX(90deg)';
                card.style.transition = 'transform 0.15s ease-in';

                setTimeout(() => {
                    try {
                        document.getElementById('btn-show-answer').classList.add('hidden'); document.getElementById('train-answer-block').classList.remove('hidden');
                        const w = trainList[curIdx]; if (w.word_type === 'noun' && w.plural) document.getElementById('train-de-plural').classList.remove('hidden'); else if (w.word_type === 'verb' && (w.praeteritum || w.partizip)) document.getElementById('train-de-plural').classList.remove('hidden');

                        if (!currentIsGermanQuestion) {
                            const fullGerman = (w.word_type === 'noun' ? (w.article || '') + ' ' : '') + (w.word_de || '');
                            setTimeout(() => speakWord(fullGerman), 100);
                        }

                        card.style.transform = 'rotateX(0deg)';
                        card.style.transition = 'transform 0.2s ease-out';
                    } catch (e) { console.error(e); } finally {
                        setTimeout(() => { _isFlipping = false; }, 200);
                    }
                }, 150);
            } catch (err) { _isFlipping = false; }
        };

        // --- МИНИ-ИГРА 1: КОНСТРУКТОР ФРАЗ ---
        let builderTarget = "";
        let builderWords = [];
        let builderSelected = [];



        // --- KEYBOARD SHORTCUTS ---
        // --- KEYBOARD SHORTCUTS ---
        document.addEventListener('keydown', (e) => {
            if (_isScoring || _isFlipping) return;
            // Flashcards Shortcuts
            if (!document.getElementById('view-train').classList.contains('hidden') && !document.getElementById('train-card-block').classList.contains('hidden')) {
                // Showing answer
                if (!document.getElementById('btn-show-answer').classList.contains('hidden')) {
                    if (e.code === 'Space' || e.code === 'Enter') {
                        e.preventDefault();
                        document.getElementById('btn-show-answer').click();
                        return;
                    }
                } else if (!document.getElementById('train-answer-block').classList.contains('hidden')) {
                    if (e.code === 'Digit1') {
                        e.preventDefault();
                        document.getElementById('btn-forgot').click();
                        return;
                    } else if (e.code === 'Digit2' || e.code === 'Space' || e.code === 'Enter') {
                        e.preventDefault();
                        document.getElementById('btn-remembered').click();
                        return;
                    }
                }
            }
        });

        // --- ТРЕНАЖЕР ГЛАГОЛОВ (КАРТОЧКИ) ---
        let vtQueue = [];
        let vtIdx = 0;
        let vtMode = 'praet';

        window.startVerbTrainer = () => {
            vtQueue = globalWords.filter(w => w.word_type === 'verb' && w.praeteritum && w.partizip).sort(() => 0.5 - Math.random());
            if (vtQueue.length === 0) return alert(t("Заполните формы Präteritum и Partizip II у глаголов в словаре!"));

            vtIdx = 0;
            sessionStartMs = Date.now();
            document.getElementById('train-topics-container').parentElement.classList.add('hidden');
            document.getElementById('verb-trainer-game').classList.remove('hidden');
            const vtXpPanel = document.getElementById('vt-xp-panel');
            if (vtXpPanel) vtXpPanel.style.display = 'flex';
            updateExperience();
            renderVerbCard();
        };

        window.setVTMode = (mode) => {
            vtMode = mode;
            document.getElementById('vt-mode-praet').className = mode === 'praet' ? "flex-1 py-2 text-xs font-bold rounded-lg bg-[#2A3B5E] shadow-sm transition-all text-white" : "flex-1 py-2 text-xs font-bold rounded-lg text-gray-500 transition-all hover:text-gray-700 dark:hover:text-[#D4AF37]";
            document.getElementById('vt-mode-perf').className = mode === 'perf' ? "flex-1 py-2 text-xs font-bold rounded-lg bg-[#2A3B5E] shadow-sm transition-all text-white" : "flex-1 py-2 text-xs font-bold rounded-lg text-gray-500 transition-all hover:text-gray-700 dark:hover:text-[#D4AF37]";
            renderVerbCard();
        };

        window.renderVerbCard = () => {
            if (vtIdx >= vtQueue.length) {
                if (window.confetti) confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
                alert(t("Отлично! Все глаголы пройдены."));
                document.getElementById('train-topics-container').parentElement.classList.remove('hidden');
                document.getElementById('verb-trainer-game').classList.add('hidden');
                const vtXpPanel = document.getElementById('vt-xp-panel');
                if (vtXpPanel) vtXpPanel.style.display = 'none';
                return;
            }
            const w = vtQueue[vtIdx];
            document.getElementById('vt-counter').innerText = `${vtQueue.length - vtIdx}`;
            const vtRemLabel = document.getElementById('vt-remaining-label');
            if (vtRemLabel) vtRemLabel.innerText = t('Осталось:');
            // German = primary (big, vt-inf), Russian = secondary (small, vt-ru)
            document.getElementById('vt-inf').innerText = w.word_de;
            document.getElementById('vt-ru').innerText = w.word_ru;

            document.getElementById('vt-answer-block').classList.add('hidden');
            document.getElementById('vt-btn-show').classList.remove('hidden');
        };

        window.showVTAnswer = () => {
            triggerVibration(15);
            const w = vtQueue[vtIdx];
            if (vtMode === 'praet') {
                // Präteritum mode: show praeteritum form only
                document.getElementById('vt-answer').innerText = w.praeteritum || '—';
            } else {
                // Partizip II / Perfekt mode: show with haben/sein helper
                const seinVerbs = ['gehen', 'fahren', 'laufen', 'fliegen', 'kommen', 'ankommen', 'werden', 'sein', 'bleiben', 'passieren', 'fallen', 'steigen', 'aufstehen', 'einschlafen', 'aufwachen', 'wachsen', 'entstehen', 'sterben'];
                const inf = (w.word_de || '').toLowerCase();
                const rawPartizipLower = (w.partizip || '').toLowerCase().trim();
                const alreadyHasAux = rawPartizipLower.startsWith('hat ') || rawPartizipLower.startsWith('ist ') || rawPartizipLower.startsWith('haben ') || rawPartizipLower.startsWith('sein ');
                const aux = seinVerbs.some(v => inf.includes(v)) ? 'ist' : 'hat';
                const answerHtml = alreadyHasAux ? escapeStr(w.partizip) : `<span class="text-gray-400 text-sm mr-1">${aux}</span>${escapeStr(w.partizip)}`;
                document.getElementById('vt-answer').innerHTML = answerHtml;
            }
            const container = document.getElementById('verb-trainer-game').querySelector('.glass-card');
            container.classList.add('perspective-1000', 'transform-style-3d');
            container.style.transform = 'rotateY(90deg)';
            container.style.transition = 'transform 0.15s ease-in';
            setTimeout(() => {
                document.getElementById('vt-btn-show').classList.add('hidden');
                document.getElementById('vt-answer-block').classList.remove('hidden');
                container.style.transform = 'rotateY(0deg)';
                container.style.transition = 'transform 0.2s ease-out';
            }, 150);
        };

        window.answerVerb = (remembered) => {
            if (remembered) {
                playTone(800, 'sine', 0.3);
                const { key, stats } = getDailyStats();
                stats.reviews++;
                localStorage.setItem(key, JSON.stringify(stats));

                const xpKey = `total_xp_${currentUser}`;
                const newTotal = (parseInt(localStorage.getItem(xpKey) || '0', 10)) + 5;
                localStorage.setItem(xpKey, newTotal);

                showXPFloat(5, window.innerWidth / 2, window.innerHeight / 3);
                updateExperience();
            } else {
                playTone(200, 'sawtooth', 0.2);
                // No XP for wrong
            }
            if (!remembered) { vtQueue.push({ ...vtQueue[vtIdx] }); }
            vtIdx++;
            renderVerbCard();
        };

        // --- СТАТИСТИКА И ТЕПЛОВАЯ КАРТА ---
        function generateHeatmap(history) {
            let daysHtml = '';
            const getDayNames = () => ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'].map(d => window.i18nDict && window.i18nDict[d] && currentLang !== 'ru' ? window.i18nDict[d][currentLang] : d);
            let maxMins = DAILY_GOAL_MINUTES;
            let weeklyTotal = 0;

            for (let i = 6; i >= 0; i--) {
                let d = new Date(); d.setDate(d.getDate() - i);
                let iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
                let mins = (history[iso] || 0) / 60000;
                weeklyTotal += mins;
                if (mins > maxMins) maxMins = mins;
            }

            for (let i = 6; i >= 0; i--) {
                let d = new Date(); d.setDate(d.getDate() - i);
                let iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
                let mins = (history[iso] || 0) / 60000;

                let dayName = i === 0 ? t('Сегодня') : getDayNames()[d.getDay()];
                let heightPct = mins === 0 ? 0 : Math.max(5, (mins / maxMins) * 100);
                
                let barColor = 'bg-transparent';
                if (mins > 0 && mins < 30) barColor = 'bg-slate-600/40';
                else if (mins >= 30 && mins < 60) barColor = 'bg-amber-500';
                else if (mins >= 60) barColor = 'bg-purple-600';
                
                let extraGlow = '';
                if (i === 0 && mins > 0) {
                    if (mins < 30) extraGlow = ' shadow-[0_0_15px_rgba(71,85,105,0.6)] animate-pulse';
                    else if (mins < 60) extraGlow = ' shadow-[0_0_15px_rgba(245,158,11,0.6)] animate-pulse';
                    else extraGlow = ' shadow-[0_0_15px_rgba(147,51,234,0.8)] animate-pulse';
                }

                let textColor = i === 0 ? 'text-[#AA7C11] dark:text-[#FDE08B] font-black' : 'text-gray-500 font-bold';

                daysHtml += `
                <div class="flex flex-col items-center flex-1 gap-1.5 group">
                    <span class="text-[10px] font-bold ${mins > 0 ? 'text-gray-500 dark:text-[#D4AF37]' : 'text-transparent'} transition-all">${Math.round(mins)}${t('м')}</span>
                    <div class="w-full max-w-[36px] h-28 bg-[#172A45] dark:bg-[#172A45]/50 rounded-[10px] flex flex-col justify-end overflow-hidden border border-gray-100 dark:border-gray-700/50">
                        <div class="w-full ${barColor}${extraGlow} transition-all duration-1000 ease-out rounded-[8px]" style="height: ${heightPct}%"></div>
                    </div>
                    <span class="text-[9px] ${textColor} uppercase tracking-widest mt-1 truncate max-w-full px-1 text-center">${dayName}</span>
                </div>`;
            }

            return `
            <div class="mb-2 text-[11px] text-gray-400 font-medium">${t('Цель недели')}: <span class="text-[#D4AF37] font-bold ml-1">${Math.round(weeklyTotal)} / 300 ${t('мин')}</span></div>
            <div class="flex items-end justify-between w-full mt-2 mb-2 px-1 gap-2">
                ${daysHtml}
            </div>
            `;
        }



        async function loadStats() {
            const totalCount = globalWords.length;
            const mastered = globalWords.filter(w => w.score >= MAX_SCORE).length;
            const learnedVerbs = globalWords.filter(w => w.word_type === 'verb' && w.score >= MAX_SCORE).length;

            try {
                const historyResult = await Promise.allSettled([
                    apiFetch('/history').then(r => r.json())
                ]);
                let serverHistory = historyResult[0].status === 'fulfilled' ? historyResult[0].value : (JSON.parse(localStorage.getItem('studyHistory')) || {});

                const statsContainer = document.getElementById('stats-container');
                if (statsContainer) {
                    statsContainer.innerHTML = `
                        <div class="bg-[#112240] rounded-[2rem] p-6 shadow-lg border border-white/5 mb-6 text-center">
                            <h3 class="text-lg font-bold text-white mb-2">${t('Архив')}</h3>
                            <p class="text-sm text-gray-400">${t('Слов выучено:')} <span id="prof-mastered-text" class="text-[#D4AF37] font-bold text-xl">${mastered}</span> / <span id="prof-total-text">${totalCount}</span></p>
                            <p class="text-sm text-gray-400 mt-2">${t('Глаголов выучено:')} <span id="prof-verbs-text" class="text-[#D4AF37] font-bold text-xl">${learnedVerbs}</span></p>
                        </div>
                        
                        <div class="bg-[#112240] rounded-[2rem] p-6 shadow-lg border border-white/5 mb-6">
                            <h3 class="text-lg font-bold text-white mb-2">${t('Активность')}</h3>
                            ${generateHeatmap(serverHistory)}
                        </div>
                    `;
                }
            } catch (e) { console.error('Stats error:', e); }
        }

        window.resetFolderStats = async (f, l, s) => {
            if (confirm(t(`Вы уверены, что хотите сбросить прогресс для темы "${s}" ?`))) {
                try {
                    await apiFetch('/words/reset_folder', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: f, level: l, subfolder: s }) });
                    await fetchWords(); await loadStats();
                } catch (e) { alert(t("Ошибка сброса!")); }
            }
        };

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                if (sessionStartMs > 0) saveSessionTime();
            } else {
                if (!document.getElementById('train-card-block').classList.contains('hidden')) {
                    sessionStartMs = Date.now();
                }
            }
        });

        // --- SWIPE PHYSICS FOR CARDS (TINDER-STYLE) ---
        const setupCardSwipes = () => {
            const card = document.getElementById('train-card-block');
            const indRight = document.getElementById('swipe-indicator-right');
            const indLeft = document.getElementById('swipe-indicator-left');
            if (!card) return;

            // Prepare card for GPU compositing from the start
            card.style.willChange = 'transform';

            let startX = 0;
            let currentX = 0;
            let isDragging = false;
            let swipeHandled = false; // Prevent double-fire on touchend
            let rafId = null;

            card.addEventListener('touchstart', (e) => {
                if (_isScoring || document.getElementById('train-answer-block').classList.contains('hidden')) return;
                startX = e.touches[0].clientX;
                currentX = startX;
                isDragging = true;
                swipeHandled = false;
                // Remove transition immediately so drag feels instant
                card.style.transition = 'none';
                indRight.style.opacity = '0';
                indLeft.style.opacity = '0';
            }, { passive: true });

            card.addEventListener('touchmove', (e) => {
                if (!isDragging || document.getElementById('train-answer-block').classList.contains('hidden')) return;
                currentX = e.touches[0].clientX;
                const diffX = currentX - startX;

                // Use rAF to batch DOM writes → no jitter
                if (rafId) cancelAnimationFrame(rafId);
                rafId = requestAnimationFrame(() => {
                    const rotate = diffX * 0.045;
                    card.style.transform = `translateX(${diffX}px) rotate(${rotate}deg)`;

                    let scaleVal;
                    if (diffX > 20) {
                        const ratio = Math.min((diffX - 20) / 80, 1);
                        indRight.style.opacity = ratio.toString();
                        indLeft.style.opacity = '0';
                        scaleVal = 0.6 + (ratio * 0.4);
                        indRight.style.transform = `translateY(-50%) rotate(-15deg) scale(${scaleVal})`;
                    } else if (diffX < -20) {
                        const ratio = Math.min((Math.abs(diffX) - 20) / 80, 1);
                        indLeft.style.opacity = ratio.toString();
                        indRight.style.opacity = '0';
                        scaleVal = 0.6 + (ratio * 0.4);
                        indLeft.style.transform = `translateY(-50%) rotate(15deg) scale(${scaleVal})`;
                    } else {
                        indRight.style.opacity = '0';
                        indLeft.style.opacity = '0';
                        indRight.style.transform = 'translateY(-50%) rotate(-15deg) scale(0.6)';
                        indLeft.style.transform = 'translateY(-50%) rotate(15deg) scale(0.6)';
                    }
                });
            }, { passive: true });

            // After card flies off screen, hide it without any flash.
            // renderCard() will fade the card back in after updating content.
            const resetCard = () => {
                card.style.transition = 'none';
                card.style.transform = '';
                card.style.opacity = '0'; // stay hidden — renderCard will reveal
                indRight.style.opacity = '0';
                indLeft.style.opacity = '0';
                void card.offsetHeight; // force reflow
                // Do NOT restore opacity here — renderCard handles it
            };

            card.addEventListener('touchend', () => {
                if (!isDragging || swipeHandled) return;
                isDragging = false;
                if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
                const diffX = currentX - startX;

                if (diffX > 80) {
                    // Swiped Right — Remembered
                    swipeHandled = true;
                    card.style.transition = 'transform 0.32s cubic-bezier(0.25, 0.8, 0.25, 1), opacity 0.25s ease';
                    card.style.transform = `translateX(110vw) rotate(28deg)`;
                    card.style.opacity = '0';
                    indRight.style.opacity = '1';
                    triggerVibration(10);
                    setTimeout(() => {
                        indRight.style.opacity = '0';
                        resetCard();
                        _swipeInProgress = true;
                        const btn = document.getElementById('btn-remembered');
                        if (btn) btn.click();
                    }, 320);
                } else if (diffX < -80) {
                    // Swiped Left — Forgot
                    swipeHandled = true;
                    card.style.transition = 'transform 0.32s cubic-bezier(0.25, 0.8, 0.25, 1), opacity 0.25s ease';
                    card.style.transform = `translateX(-110vw) rotate(-28deg)`;
                    card.style.opacity = '0';
                    indLeft.style.opacity = '1';
                    triggerVibration([10, 20]);
                    setTimeout(() => {
                        indLeft.style.opacity = '0';
                        resetCard();
                        _swipeInProgress = true;
                        const btn = document.getElementById('btn-forgot');
                        if (btn) btn.click();
                    }, 320);
                } else {
                    // Snap back with spring feel
                    card.style.transition = 'transform 0.38s cubic-bezier(0.34, 1.56, 0.64, 1)';
                    card.style.transform = 'translateX(0) rotate(0deg)';
                    indRight.style.opacity = '0';
                    indLeft.style.opacity = '0';
                    setTimeout(() => { card.style.transition = 'none'; }, 380);
                }
            });
        };
        setupCardSwipes();

        // --- PWA REGISTRATION ---
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('/sw.js').catch(() => { });
            });
        }

        switchView('dict');
    