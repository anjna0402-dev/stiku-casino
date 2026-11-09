const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data.json');

// Helper to read database
function getData() {
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, JSON.stringify({ balances: { "player1": 1000, "player2": 1000, "admin": 1000 } }, null, 2));
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

// Helper to write database
function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Handle balance and tip requests
function handleApi(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

    // 1. Get Balance
    if (parsedUrl.pathname === '/api/balance') {
        const user = parsedUrl.searchParams.get('user') || parsedUrl.searchParams.get('username') || 'player1';
        const data = getData();
        
        if (!data.balances) data.balances = {};
        if (!data.balances[user]) {
            data.balances[user] = 1000;
            saveData(data);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ balance: data.balances[user] }));
        return true; 
    }

    // 2. Send Tip (Flexible so it never crashes)
    if (req.method === 'POST' && parsedUrl.pathname === '/api/tip') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const reqData = JSON.parse(body || '{}');
                
                // Automatically catch any naming style your frontend uses
                const sender = reqData.sender || reqData.from || reqData.user || 'player1';
                const recipient = reqData.recipient || reqData.to || reqData.target || reqData.user2;
                const amount = Number(reqData.amount || reqData.tip || reqData.value || 0);

                const data = getData();
                if (!data.balances) data.balances = {};

                if (!recipient) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Recipient not specified!' }));
                    return;
                }

                // Ensure sender and recipient exist in database
                if (!data.balances[sender]) data.balances[sender] = 1000;
                if (!data.balances[recipient]) data.balances[recipient] = 1000;

                if (data.balances[sender] < amount) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Insufficient funds!' }));
                    return;
                }

                // Transfer the points
                data.balances[sender] -= amount;
                data.balances[recipient] += amount;
                saveData(data);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, newBalance: data.balances[sender] }));
            } catch (err) {
                console.error("TIP ERROR:", err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Server error: ' + err.message }));
            }
        });
        return true; 
    }

    return false; 
}

module.exports = { handleApi };