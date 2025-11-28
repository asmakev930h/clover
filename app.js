
require('dotenv').config(); 
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer'); 
const { v4: uuidv4 } = require('uuid');
const http = require('http'); 
const { Server } = require("socket.io"); 

const app = express();
const server = http.createServer(app); 
const io = new Server(server); 
const PORT = 7860;

// --- CONFIGURATION ---
const HF_TOKEN = process.env.HF_TOKEN;
const REPO_ID = "api-ix/storage"; 
const BRANCH = "main";

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- MULTER SETUP ---
const tempDir = path.join(__dirname, 'database', 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, tempDir); },
    filename: function (req, file, cb) { cb(null, `${uuidv4()}${path.extname(file.originalname)}`); }
});
const upload = multer({ storage: storage });

// --- DATABASE INITIALIZATION ---
const dbDir = path.join(__dirname, 'database');
const usersPath = path.join(dbDir, 'users.json');
const chatsPath = path.join(dbDir, 'chats.json'); 

if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir);
if (!fs.existsSync(usersPath)) fs.writeFileSync(usersPath, '[]');
if (!fs.existsSync(chatsPath)) fs.writeFileSync(chatsPath, '{}'); 

// --- HELPER FUNCTIONS ---
function generateProfileId(length = 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) { result += chars.charAt(Math.floor(Math.random() * chars.length)); }
    return result;
}
function generateRandomId(length = 7) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) { result += chars.charAt(Math.floor(Math.random() * chars.length)); }
    return result;
}
function getRoomId(id1, id2) {
    return [id1, id2].sort().join('_');
}

// --- HUGGING FACE UPLOAD (GENERIC) ---
async function uploadFileToHF(localFilePath, originalExtension) {
    if (!HF_TOKEN) throw new Error("HF_TOKEN is missing");
    const { commit, createRepo } = await import('@huggingface/hub');
    try { await createRepo({ repo: REPO_ID, accessToken: HF_TOKEN, type: "model" }); } catch (err) { if (!err.message.includes("You already created this")) throw err; }
    
    const buffer = fs.readFileSync(localFilePath);
    const blob = new Blob([buffer]);
    const randomFileName = `${generateRandomId()}${originalExtension}`;
    
    await commit({
        repo: REPO_ID, credentials: { accessToken: HF_TOKEN }, title: `Upload ${randomFileName}`, branch: BRANCH,
        operations: [{ operation: "addOrUpdate", path: randomFileName, content: blob }]
    });
    return `https://huggingface.co/${REPO_ID}/resolve/${BRANCH}/${randomFileName}`;
}

// --- API ROUTES ---

// 1. Signup
app.post('/auth/signup', (req, res) => {
    const { fullname, username, email, password } = req.body;
    if (!fullname || !username || !email || !password) return res.status(400).json({ error: 'All fields required' });
    const lowerUsername = username.trim().toLowerCase();
    fs.readFile(usersPath, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        let users = []; try { users = JSON.parse(data || '[]'); } catch (e) { users = []; }
        if (users.some(u => u.email === email)) return res.status(409).json({ error: 'Email exists' });
        if (users.some(u => u.username === lowerUsername)) return res.status(409).json({ error: 'Username exists' });
        const newUser = {
            id: uuidv4(), fullname, username: lowerUsername, email, password,
            profileId: generateProfileId(8), profileImage: null, VerifiedBarge: false, createdAt: new Date().toISOString()
        };
        users.push(newUser);
        fs.writeFile(usersPath, JSON.stringify(users, null, 2), (wErr) => {
            if (wErr) return res.status(500).json({ error: 'Save failed' });
            res.status(201).json({ message: 'User created' });
        });
    });
});

// 2. Login
app.post('/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Credentials required' });
    fs.readFile(usersPath, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        let users = []; try { users = JSON.parse(data || '[]'); } catch (e) { users = []; }
        const user = users.find(u => (u.email === username || u.username === username.trim().toLowerCase()) && u.password === password);
        if (user) {
            res.status(200).json({ message: 'Login successful', user: { 
                id: user.id, username: user.username, fullname: user.fullname, profileId: user.profileId, 
                profileImage: user.profileImage, VerifiedBarge: user.VerifiedBarge } 
            });
        } else { res.status(401).json({ error: 'Invalid credentials' }); }
    });
});

// 3. Verify
app.post('/auth/verify', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ valid: false });
    fs.readFile(usersPath, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        let users = []; try { users = JSON.parse(data || '[]'); } catch (e) { users = []; }
        const user = users.find(u => u.id === userId);
        if (user) {
            res.status(200).json({ valid: true, user: { 
                fullname: user.fullname, username: user.username, email: user.email, profileId: user.profileId, 
                profileImage: user.profileImage, VerifiedBarge: user.VerifiedBarge } 
            });
        } else { res.status(401).json({ valid: false }); }
    });
});

// 4. Upload Profile (Images)
app.post('/auth/upload-profile', upload.single('image'), async (req, res) => {
    const { userId } = req.body; const file = req.file;
    if (!userId || !file) return res.status(400).json({ error: 'Missing data' });
    try {
        const hfUrl = await uploadFileToHF(file.path, path.extname(file.originalname));
        fs.unlinkSync(file.path);
        fs.readFile(usersPath, 'utf8', (err, data) => {
            let users = JSON.parse(data || '[]'); const idx = users.findIndex(u => u.id === userId);
            if (idx === -1) return res.status(404).json({ error: 'User not found' });
            users[idx].profileImage = hfUrl;
            fs.writeFile(usersPath, JSON.stringify(users, null, 2), () => { res.status(200).json({ success: true, imageUrl: hfUrl }); });
        });
    } catch (error) { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); res.status(500).json({ error: error.message }); }
});

// --- CHAT FILE UPLOAD ---
app.post('/chat/upload', upload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    
    try {
        const hfUrl = await uploadFileToHF(file.path, path.extname(file.originalname));
        fs.unlinkSync(file.path); // Clean temp
        res.status(200).json({ success: true, fileUrl: hfUrl, fileName: file.originalname });
    } catch (error) {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        res.status(500).json({ error: error.message });
    }
});

// 5. Update Profile
app.post('/auth/update-profile', (req, res) => {
    const { userId, fullname, email } = req.body;
    fs.readFile(usersPath, 'utf8', (err, data) => {
        let users = JSON.parse(data || '[]'); const idx = users.findIndex(u => u.id === userId);
        if (idx === -1) return res.status(404).json({ error: 'User not found' });
        users[idx].fullname = fullname; users[idx].email = email;
        fs.writeFile(usersPath, JSON.stringify(users, null, 2), () => { res.status(200).json({ success: true }); });
    });
});

// 6. Change Password
app.post('/auth/change-password', (req, res) => {
    const { userId, currentPassword, newPassword } = req.body;
    fs.readFile(usersPath, 'utf8', (err, data) => {
        let users = JSON.parse(data || '[]'); const idx = users.findIndex(u => u.id === userId);
        if (users[idx].password !== currentPassword) return res.status(401).json({ error: 'Incorrect current password' });
        users[idx].password = newPassword;
        fs.writeFile(usersPath, JSON.stringify(users, null, 2), () => { res.status(200).json({ success: true }); });
    });
});

// 7. Remove Profile Image
app.post('/auth/remove-profile-image', (req, res) => {
    const { userId } = req.body;
    fs.readFile(usersPath, 'utf8', (err, data) => {
        let users = JSON.parse(data || '[]'); const idx = users.findIndex(u => u.id === userId);
        users[idx].profileImage = null;
        fs.writeFile(usersPath, JSON.stringify(users, null, 2), () => { res.status(200).json({ success: true }); });
    });
});

// 8. Delete Account
app.post('/auth/delete-account', (req, res) => {
    const { userId, password } = req.body;
    fs.readFile(usersPath, 'utf8', (err, data) => {
        let users = JSON.parse(data || '[]'); const idx = users.findIndex(u => u.id === userId);
        if (users[idx].password !== password) return res.status(401).json({ error: 'Incorrect password' });
        users.splice(idx, 1);
        fs.writeFile(usersPath, JSON.stringify(users, null, 2), () => { res.status(200).json({ success: true }); });
    });
});

// 9. Get User's Chat List
app.get('/api/my-chats', (req, res) => {
    const { userId } = req.query; 
    if (!userId) return res.status(400).json({ error: 'User ID required' });

    fs.readFile(usersPath, 'utf8', (err, usersData) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        
        fs.readFile(chatsPath, 'utf8', (err, chatsData) => {
            if (err) return res.status(500).json({ error: 'DB error' });

            const users = JSON.parse(usersData || '[]');
            const chats = JSON.parse(chatsData || '{}');
            const myChats = [];

            const me = users.find(u => u.id === userId);
            if (!me) return res.status(404).json({ error: 'User not found' });

            Object.keys(chats).forEach(roomId => {
                if (roomId.includes(userId)) {
                    const ids = roomId.split('_');
                    const otherId = ids.find(id => id !== userId);

                    const otherUser = users.find(u => u.id === otherId);
                    const history = chats[roomId];
                    const lastMsg = history.length > 0 ? history[history.length - 1] : null;

                    // Calculate Unread
                    const unreadCount = history.filter(msg => msg.senderId !== me.profileId && !msg.read).length;

                    if (otherUser && lastMsg) {
                        let previewText = lastMsg.text;
                        if (!previewText && lastMsg.type !== 'text') {
                            if(lastMsg.type === 'image') previewText = '📷 Image';
                            else if(lastMsg.type === 'video') previewText = '🎥 Video';
                            else if(lastMsg.type === 'file') previewText = '📁 File';
                        } else if (lastMsg.type !== 'text') {
                             // If there is both text and media
                             previewText = '📎 ' + previewText;
                        }

                        myChats.push({
                            profileId: otherUser.profileId,
                            fullname: otherUser.fullname,
                            username: otherUser.username,
                            profileImage: otherUser.profileImage,
                            VerifiedBarge: otherUser.VerifiedBarge,
                            lastMessage: previewText,
                            timestamp: lastMsg.timestamp,
                            unreadCount: unreadCount 
                        });
                    }
                }
            });

            myChats.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            res.json({ chats: myChats });
        });
    });
});

// 9.5 Get Public User Info (For Header & Verification)
app.get('/api/user-info', (req, res) => {
    const { profileId } = req.query;
    if (!profileId) return res.status(400).json({ error: 'Profile ID required' });
    
    fs.readFile(usersPath, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        let users = [];
        try { users = JSON.parse(data || '[]'); } catch (e) { users = []; }
        
        const user = users.find(u => u.profileId === profileId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        res.json({
            fullname: user.fullname,
            username: user.username,
            profileImage: user.profileImage,
            VerifiedBarge: user.VerifiedBarge
        });
    });
});

// 10. Download Proxy
app.get('/chat/download', async (req, res) => {
    const { url, filename } = req.query;
    if (!url || !filename) return res.status(400).send('Missing url or filename');

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');

        // Handle stream piping
        const { Readable } = require('stream');
        if (response.body) {
             Readable.fromWeb(response.body).pipe(res);
        } else {
             res.status(500).send('No response body');
        }
        
    } catch (error) {
        console.error("Download Error:", error);
        res.status(500).send('Error downloading file');
    }
});

// --- SOCKET.IO CHAT LOGIC ---

io.on('connection', (socket) => {
    
    // A. Join Home
    socket.on('join_home', (myProfileId) => {
        socket.join(`home_${myProfileId}`);
    });

    // B. Join Chat Room
    socket.on('join_chat', ({ myProfileId, otherProfileId }) => {
        fs.readFile(usersPath, 'utf8', (err, data) => {
            if(err) return;
            const users = JSON.parse(data || '[]');
            const me = users.find(u => u.profileId === myProfileId);
            const other = users.find(u => u.profileId === otherProfileId);

            if (me && other) {
                const roomId = getRoomId(me.id, other.id);
                socket.join(roomId);
                
                fs.readFile(chatsPath, 'utf8', (cErr, cData) => {
                    const chats = JSON.parse(cData || '{}');
                    const history = chats[roomId] || [];
                    socket.emit('load_history', history);
                });
            }
        });
    });

    // C. Send Message (Handles Caption + Media)
    socket.on('send_message', ({ myProfileId, otherProfileId, message, type, fileUrl, fileName }) => {
         fs.readFile(usersPath, 'utf8', (err, data) => {
            const users = JSON.parse(data || '[]');
            const me = users.find(u => u.profileId === myProfileId);
            const other = users.find(u => u.profileId === otherProfileId);

            if (me && other) {
                const roomId = getRoomId(me.id, other.id);
                
                const msgData = {
                    senderId: me.profileId,
                    text: message || '', 
                    type: type || 'text',
                    fileUrl: fileUrl || null,
                    fileName: fileName || null,
                    timestamp: new Date().toISOString(),
                    read: false
                };

                fs.readFile(chatsPath, 'utf8', (cErr, cData) => {
                    const chats = JSON.parse(cData || '{}');
                    if (!chats[roomId]) chats[roomId] = [];
                    chats[roomId].push(msgData);

                    fs.writeFile(chatsPath, JSON.stringify(chats, null, 2), () => {
                        io.to(roomId).emit('receive_message', msgData);
                        io.to(`home_${otherProfileId}`).emit('update_home_chats');
                        io.to(`home_${myProfileId}`).emit('update_home_chats');
                    });
                });
            }
        });
    });

    // D. Mark Read
    socket.on('mark_read', ({ myProfileId, otherProfileId }) => {
        fs.readFile(usersPath, 'utf8', (err, uData) => {
            if(err) return;
            const users = JSON.parse(uData || '[]');
            const me = users.find(u => u.profileId === myProfileId);
            const other = users.find(u => u.profileId === otherProfileId);

            if(me && other) {
                const roomId = getRoomId(me.id, other.id);
                fs.readFile(chatsPath, 'utf8', (cErr, cData) => {
                    const chats = JSON.parse(cData || '{}');
                    if(chats[roomId]) {
                        let changed = false;
                        chats[roomId].forEach(msg => {
                            if(msg.senderId === otherProfileId && !msg.read) {
                                msg.read = true;
                                changed = true;
                            }
                        });
                        if(changed) {
                            fs.writeFile(chatsPath, JSON.stringify(chats, null, 2), () => {
                                io.to(roomId).emit('messages_read');
                            });
                        }
                    }
                });
            }
        });
    });
});

// --- SERVE PAGES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/forget', (req, res) => res.sendFile(path.join(__dirname, 'public', 'forget.html')));
app.get('/home', (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
