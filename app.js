/**
 * Hive Exporter Pro - Versão Final com Cache e Retomada Estável
 */
const CONFIG = {
    NODES: ["https://api.hive.blog", "https://api.deathwing.me", "https://api.openhive.network"],
    FETCH_TIMEOUT: 8000,
    POST_BATCH_SIZE: 20,
    CONCURRENCY_POSTS: 5,
    CONCURRENCY_IMAGES: 8,
    DB_NAME: "HiveExporterDB",
    STORE_NAME: "posts"
};

let GLOBAL_POSTS = [];
let currentNodeIndex = 0;
let isSearching = false; 

// --- 1. SISTEMA DE CACHE (INDEXEDDB) ---

const db = {
    open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(CONFIG.DB_NAME, 1);
            request.onupgradeneeded = e => e.target.result.createObjectStore(CONFIG.STORE_NAME, { keyPath: "permlink" });
            request.onsuccess = e => resolve(e.target.result);
            request.onerror = e => reject(e.target.error);
        });
    },
    async savePost(post) {
        const _db = await this.open();
        const tx = _db.transaction(CONFIG.STORE_NAME, "readwrite");
        tx.objectStore(CONFIG.STORE_NAME).put(post);
        return new Promise(resolve => tx.oncomplete = () => resolve());
    },
    async getAll(username) {
        const _db = await this.open();
        return new Promise(resolve => {
            const request = _db.transaction(CONFIG.STORE_NAME).objectStore(CONFIG.STORE_NAME).getAll();
            request.onsuccess = () => {
                resolve(request.result.filter(p => p.author === username));
            };
        });
    },
    async clear() {
        const _db = await this.open();
        const tx = _db.transaction(CONFIG.STORE_NAME, "readwrite");
        tx.objectStore(CONFIG.STORE_NAME).clear();
        log("Cache local esvaziado.", "ok");
    }
};

// --- 2. UTILITÁRIOS E UI ---

const getEl = (id) => document.getElementById(id);
const log = (msg, type = "def") => {
    const box = getEl("logConsole");
    const d = document.createElement("div");
    d.className = `log-item ${type}`;
    d.textContent = `> ${msg}`;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
};

const setProgress = (percent, text) => {
    getEl("progressBar").style.width = `${percent}%`;
    if (text) getEl("statusMsg").textContent = text;
    getEl("percentMsg").textContent = `${Math.floor(percent)}%`;
};

const safeFileName = (s) => s.replace(/[/\\?%*:|"<>]/g, '-').substring(0, 50).trim();

function toggleRangeInputs() {
    const mode = getEl("exportMode").value;
    const isPdf = mode === "pdf_all";
    getEl("rangeContainer").classList.toggle("hidden", isPdf);
    getEl("pdfBtnContainer").classList.toggle("hidden", !isPdf);
}

// --- 3. NÚCLEO DA API HIVE ---

async function hiveCall(method, params) {
    for (let i = 0; i < CONFIG.NODES.length; i++) {
        const node = CONFIG.NODES[currentNodeIndex];
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT);
        try {
            const res = await fetch(node, {
                method: "POST",
                body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
                headers: { "Content-Type": "application/json" },
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error.message);
            return data.result;
        } catch (e) {
            log(`Falha no nó ${node}: ${e.message}`, "warn");
            currentNodeIndex = (currentNodeIndex + 1) % CONFIG.NODES.length;
        }
    }
    throw new Error(`Todos os nós falharam.`);
}

// --- 4. BUSCA DE POSTS (FUNÇÃO ÚNICA COM RETOMADA) ---

async function fetchAllPosts(isContinuation = false) {
    const username = getEl("username").value.trim().toLowerCase();
    if (!username) return alert("Digite o usuário");

    isSearching = true;
    getEl("btnSearch").disabled = true;
    getEl("searchControls").classList.remove("hidden");
    getEl("searchControls").style.display = "flex";

    try {
        // 1. Carregar o que já temos no Cache
        GLOBAL_POSTS = await db.getAll(username);
        
        let lastAuthor = null;
        let lastPermlink = null;

        if (isContinuation && GLOBAL_POSTS.length > 0) {
            // Para continuar, ordenamos por data e pegamos o mais ANTIGO (ponto de parada na Hive)
            const sorted = [...GLOBAL_POSTS].sort((a, b) => new Date(a.created) - new Date(b.created));
            lastAuthor = sorted[0].author;
            lastPermlink = sorted[0].permlink;
            log(`Retomando de @${username} a partir de ${lastPermlink}...`, "info");
        } else {
            if (!isContinuation) {
                getEl("logConsole").innerHTML = "";
                log(`Iniciando nova busca para @${username}...`, "info");
            }
        }

        log(`Status: ${GLOBAL_POSTS.length} posts já em cache.`, "warn");

        // 2. Loop de Busca
        while (isSearching) {
            const query = { tag: username, limit: CONFIG.POST_BATCH_SIZE };
            if (lastAuthor) {
                query.start_author = lastAuthor;
                query.start_permlink = lastPermlink;
            }

            const result = await hiveCall("condenser_api.get_discussions_by_blog", [query]);
            if (!result || result.length === 0) break;

            let newsFound = 0;
            for (const p of result) {
                const isNew = !GLOBAL_POSTS.some(exist => exist.permlink === p.permlink);
                if (p.author === username && isNew) {
                    await db.savePost(p);
                    GLOBAL_POSTS.push(p);
                    newsFound++;
                }
            }

            log(`Lote processado. Total no cache: ${GLOBAL_POSTS.length}`);
            setProgress(50, `Escaneando... (${GLOBAL_POSTS.length} posts)`);

            // Se o resultado veio vazio ou apenas com o post de start, paramos
            if (result.length < CONFIG.POST_BATCH_SIZE) break;

            const lastInBatch = result[result.length - 1];
            if (lastInBatch.permlink === lastPermlink) break;

            lastAuthor = lastInBatch.author;
            lastPermlink = lastInBatch.permlink;
            
            await new Promise(r => setTimeout(r, 200)); 
        }

        if (isSearching) {
            log(`Busca concluída! ${GLOBAL_POSTS.length} posts prontos.`, "ok");
            // Ordenar por data (mais recente primeiro para a UI de download)
            GLOBAL_POSTS.sort((a, b) => new Date(b.created) - new Date(a.created));
            prepareDownloadUI();
        }

    } catch (e) {
        log(`Erro: ${e.message}`, "err");
    } finally {
        getEl("btnSearch").disabled = false;
        isSearching = false;
        setProgress(100, GLOBAL_POSTS.length > 0 ? "Pronto." : "Idle");
    }
}

function stopSearch() {
    isSearching = false;
    log("Parada solicitada. Aguardando fim do lote...", "warn");
}

async function clearAppCache() {
    if (confirm("Apagar cache local de todos os usuários?")) {
        await db.clear();
        GLOBAL_POSTS = [];
        getEl("step2").classList.add("hidden");
        log("Cache limpo.", "info");
    }
}

// --- 5. EXPORTAÇÃO E DOWNLOADS ---

function prepareDownloadUI() {
    const total = GLOBAL_POSTS.length;
    getEl("totalBadge").style.display = "block";
    getEl("totalBadge").textContent = `${total} Posts`;
    getEl("endRange").value = total;
    getEl("endRange").max = total;
    getEl("step2").classList.remove("hidden");
}

async function downloadPool(items, concurrency, workerFn) {
    const queue = [...items];
    const workers = Array(Math.min(concurrency, queue.length)).fill(null).map(async () => {
        while (queue.length > 0) {
            await workerFn(queue.shift());
        }
    });
    await Promise.all(workers);
}

const downloadHelpers = {
    getRange: (isPdf, totalPosts) => {
        const start = isPdf ? 1 : parseInt(getEl("startRange").value);
        const end = isPdf ? totalPosts : parseInt(getEl("endRange").value);
        return { start, end, isValid: (!isNaN(start) && !isNaN(end) && start >= 1 && start <= end) };
    },
    formatPostText: (post) => {
        const metadata = JSON.parse(post.json_metadata || "{}");
        const tags = metadata.tags?.join(", ") || "";
        return `TÍTULO: ${post.title}\nDATA: ${post.created}\nTAGS: ${tags}\n---\n\n${post.body}`;
    },
    writeToPdf: (pdf, post, index) => {
        pdf.addPage();
        pdf.setFontSize(14);
        pdf.text(`#${index}: ${post.title.substring(0, 80)}`, 10, 20);
        pdf.setFontSize(10);
        const splitBody = pdf.splitTextToSize(post.body, 180);
        pdf.text(splitBody, 10, 30);
    }
};

async function startDownload() {
    const mode = getEl("exportMode").value;
    const username = getEl("username").value;
    const isPdfMode = mode === "pdf_all";
    const range = downloadHelpers.getRange(isPdfMode, GLOBAL_POSTS.length);
    if (!range.isValid) return alert("Intervalo inválido");

    const postsToProcess = [...GLOBAL_POSTS].reverse().slice(range.start - 1, range.end);
    document.querySelectorAll("button").forEach(b => b.disabled = true);

    const zip = new JSZip();
    const pdf = isPdfMode ? new window.jspdf.jsPDF() : null;
    const zipFolder = !isPdfMode ? zip.folder(`${username}_backup`) : null;

    try {
        let completed = 0;
        await downloadPool(postsToProcess, CONFIG.CONCURRENCY_POSTS, async (post) => {
            const index = range.start + completed;
            const slug = safeFileName(`${post.created.split('T')[0]}_${post.permlink}`);
            if (isPdfMode) {
                downloadHelpers.writeToPdf(pdf, post, index);
            } else {
                const folder = zipFolder.folder(`${index}_${slug}`);
                folder.file("post.md", downloadHelpers.formatPostText(post));
                if (mode === "zip_full") await handleImages(post.body, folder, index);
            }
            completed++;
            setProgress((completed / postsToProcess.length) * 100, `Processando: ${completed}/${postsToProcess.length}`);
        });

        if (isPdfMode) pdf.save(`${username}_hive.pdf`);
        else {
            const blob = await zip.generateAsync({ type: "blob" });
            saveAs(blob, `${username}_hive.zip`);
        }
        log("Exportação finalizada!", "ok");
    } catch (e) {
        log(`Erro: ${e.message}`, "err");
    } finally {
        document.querySelectorAll("button").forEach(b => b.disabled = false);
    }
}

async function handleImages(body, folder, postIdx) {
    const urls = extractImageUrls(body);
    if (urls.length === 0) return;
    const imgDir = folder.folder("imagens");
    await downloadPool(urls.map((url, i) => ({ url, i })), CONFIG.CONCURRENCY_IMAGES, async ({ url, i }) => {
        try {
            const res = await fetch(`https://images.hive.blog/0x0/${url}`);
            if (!res.ok) throw new Error();
            const blob = await res.blob();
            const ext = blob.type.split("/")[1] || "jpg";
            imgDir.file(`img_${i + 1}.${ext}`, blob);
        } catch { }
    });
}

function extractImageUrls(text) {
    const urls = new Set();
    const regex = /(https?:\/\/[^\s<>"'\)]+?\.(?:jpg|jpeg|png|gif|webp|svg))/gi;
    let m;
    while ((m = regex.exec(text))) urls.add(m[1]);
    return [...urls];
}