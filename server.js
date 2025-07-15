const WebSocket = require('ws');
require('dotenv').config();
const express = require('express');
const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const basicAuth = require('basic-auth');

// Configuration
const config = {
    port: 8080,
    telegram: {
        token: process.env.TELEGRAM_TOKEN,
        adminChatId: process.env.ADMIN_CHAT_ID
    }
};

class ChatServer {
    constructor() {
        this.clients = new Map(); // clientId -> WebSocket connection
        this.activeChats = new Map(); // clientId -> chat info
        this.currentClientId = null; // Only one client supported at a time
        this.lastMessageId = 0; // For unique message IDs
        this.pendingMessages = new Map(); // messageId -> { clientId, status }
        
        this.setupExpress();
        this.setupWebSocket();
        this.setupTelegram();
        this.startServer();
    }
    
    setupExpress() {
        this.app = express();
        this.server = http.createServer(this.app);
        
        // Basic auth middleware
        this.app.use((req, res, next) => {
            const user = basicAuth(req);
            const username = process.env.WEB_USER;
            const password = process.env.WEB_PASS;
            if (user && user.name === username && user.pass === password) {
                return next();
            }
            res.set('WWW-Authenticate', 'Basic realm="Chat"');
            return res.status(401).send('Authentication required.');
        });
        // Serve static files
        this.app.use(express.static('public'));
        
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({ status: 'ok', clients: this.clients.size });
        });
    }
    
    setupWebSocket() {
        this.wss = new WebSocket.Server({ server: this.server });
        
        this.wss.on('connection', (ws) => {
            console.log('New WebSocket connection');
            
            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    this.handleWebSocketMessage(ws, data);
                } catch (error) {
                    console.error('Error parsing WebSocket message:', error);
                }
            });
            
            ws.on('close', () => {
                // Find and remove client
                for (const [clientId, client] of this.clients.entries()) {
                    if (client.ws === ws) {
                        this.handleClientDisconnect(clientId);
                        break;
                    }
                }
            });
            
            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
            });
        });
    }
    
    setupTelegram() {
        this.bot = new TelegramBot(config.telegram.token, { polling: true });
        
        this.bot.onText(/\/start/, (msg) => {
            const chatId = msg.chat.id;
            this.bot.sendMessage(chatId, 
                `Welcome to the support chat bot!\n\n` +
                `Your chat ID: ${chatId}\n\n` +
                `Commands:\n` +
                `/list - Show current chat\n` +
                `/help - Show this help message\n\n` +
                `To reply to a client, just send a message. Only one client can be supported at a time.`
            );
        });
        
        this.bot.onText(/\/list/, (msg) => {
            const chatId = msg.chat.id;
            if (chatId.toString() !== config.telegram.adminChatId) {
                this.bot.sendMessage(chatId, 'Unauthorized access.');
                return;
            }
            if (!this.currentClientId || !this.activeChats.has(this.currentClientId)) {
                this.bot.sendMessage(chatId, 'No active client.');
                return;
            }
            const chatInfo = this.activeChats.get(this.currentClientId);
            const duration = Math.floor((Date.now() - chatInfo.startTime) / 1000 / 60);
            let message = 'Current active client:\n\n';
            message += `🔹 ${this.currentClientId}\n`;
            message += `   Connected: ${duration}m ago\n`;
            message += `   Messages: ${chatInfo.messageCount}\n`;
            this.bot.sendMessage(chatId, message);
        });
        
        // Remove /reply command
        // this.bot.onText(/\/reply (.+) (.+)/, (msg, match) => {
        //     const chatId = msg.chat.id;
        //     if (chatId.toString() !== config.telegram.adminChatId) {
        //         this.bot.sendMessage(chatId, 'Unauthorized access.');
        //         return;
        //     }
            
        //     const clientId = match[1];
        //     const message = match[2];
            
        //     if (this.sendMessageToClient(clientId, message)) {
        //         this.bot.sendMessage(chatId, `✅ Message sent to ${clientId}`);
        //     } else {
        //         this.bot.sendMessage(chatId, `❌ Client ${clientId} not found or disconnected`);
        //     }
        // });
        
        this.bot.onText(/\/help/, (msg) => {
            const chatId = msg.chat.id;
            this.bot.sendMessage(chatId,
                `Support Bot Commands:\n\n` +
                `/start - Initialize bot\n` +
                `/list - Show current chat\n` +
                `/help - Show this help\n\n` +
                `To reply to a client, just send a message. Only one client can be supported at a time.`
            );
        });
        
        // Handle regular messages (admin replies)
        this.bot.on('message', (msg) => {
            const chatId = msg.chat.id;
            if (chatId.toString() !== config.telegram.adminChatId) {
                return;
            }
            // Skip command messages
            if (msg.text && msg.text.startsWith('/')) {
                return;
            }
            // Forward admin message to the current client
            if (this.currentClientId && msg.text) {
                const messageId = ++this.lastMessageId;
                this.pendingMessages.set(messageId, {
                    clientId: this.currentClientId,
                    status: 'sent',
                    text: msg.text
                });
                if (this.sendMessageToClient(this.currentClientId, msg.text, messageId)) {
                    // No confirmation message
                } else {
                    this.bot.sendMessage(chatId, `❌ No active client to send message.`);
                }
            } else if (!msg.photo && !msg.text) {
                this.bot.sendMessage(chatId, `❌ No active client to send message.`);
            }
        });

        // Handle photo messages from admin
        this.bot.on('photo', async (msg) => {
            const chatId = msg.chat.id;
            if (chatId.toString() !== config.telegram.adminChatId) return;
            if (!this.currentClientId) {
                this.bot.sendMessage(chatId, `❌ No active client to send image.`);
                return;
            }
            // Get the highest resolution photo
            const photo = msg.photo[msg.photo.length - 1];
            const fileId = photo.file_id;
            try {
                const file = await this.bot.getFile(fileId);
                const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
                // Download the image as a buffer
                const axios = require('axios');
                const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
                const base64 = Buffer.from(response.data, 'binary').toString('base64');
                const mimeType = 'image/jpeg'; // Telegram always sends jpeg
                const dataUrl = `data:${mimeType};base64,${base64}`;
                // Send to client via WebSocket
                const messageId = ++this.lastMessageId;
                this.pendingMessages.set(messageId, {
                    clientId: this.currentClientId,
                    status: 'sent',
                    text: '[Image]'
                });
                this.sendImageToClient(this.currentClientId, dataUrl, messageId);
            } catch (err) {
                this.bot.sendMessage(chatId, '❌ Failed to send image to client.');
            }
        });

        console.log('Telegram bot initialized');
    }
    
    handleWebSocketMessage(ws, data) {
        switch (data.type) {
            case 'client_connect':
                this.handleClientConnect(ws, data);
                break;
            case 'client_message':
                this.handleClientMessage(data);
                break;
            case 'client_image':
                this.handleClientImage(data);
                break;
            case 'seen':
                this.handleClientSeen(data);
                break;
        }
    }
    
    handleClientConnect(ws, data) {
        const clientId = data.clientId;
        // Only allow one client at a time
        if (this.currentClientId) {
            // Optionally, disconnect previous client
            const prevClient = this.clients.get(this.currentClientId);
            if (prevClient && prevClient.ws.readyState === WebSocket.OPEN) {
                prevClient.ws.close(4000, 'Another client connected');
            }
            this.clients.delete(this.currentClientId);
            this.activeChats.delete(this.currentClientId);
        }
        this.currentClientId = clientId;
        this.clients.set(clientId, {
            ws: ws,
            id: clientId,
            connectedAt: Date.now()
        });
        this.activeChats.set(clientId, {
            startTime: Date.now(),
            messageCount: 0
        });
        console.log(`Client connected: ${clientId}`);
        // Notify admin on Telegram
        this.bot.sendMessage(config.telegram.adminChatId,
            `🔔 New client connected\n` +
            `Client ID: ${clientId}\n` +
            `Time: ${new Date().toLocaleString()}`
        );
    }
    
    handleClientMessage(data) {
        const clientId = data.clientId;
        const message = data.message;
        if (!this.activeChats.has(clientId)) {
            return;
        }
        // Update message count
        const chatInfo = this.activeChats.get(clientId);
        chatInfo.messageCount++;
        console.log(`Message from ${clientId}: ${message}`);
        // Forward to Telegram (remove clientId from notification)
        this.bot.sendMessage(config.telegram.adminChatId,
            `💬 Message from client:\n\n${message}`
        );
    }

    handleClientImage(data) {
        // data: { clientId, dataUrl }
        const { clientId, dataUrl } = data;
        if (!this.activeChats.has(clientId)) return;
        // Forward image to Telegram admin
        // Telegram requires a file buffer for sending photos
        const base64 = dataUrl.split(',')[1];
        const buffer = Buffer.from(base64, 'base64');
        this.bot.sendPhoto(config.telegram.adminChatId, buffer, {
            caption: '💬 Image from client'
        });
    }
    
    handleClientSeen(data) {
        // data: { clientId, messageId }
        const { clientId, messageId } = data;
        const pending = this.pendingMessages.get(messageId);
        if (pending && pending.clientId === clientId && pending.status !== 'seen') {
            pending.status = 'seen';
            // Remove clientId from notification
            this.bot.sendMessage(config.telegram.adminChatId, `👁️ Seen: ${pending.text}`);
        }
    }
    
    handleClientDisconnect(clientId) {
        if (this.clients.has(clientId)) {
            this.clients.delete(clientId);
            if (this.activeChats.has(clientId)) {
                const chatInfo = this.activeChats.get(clientId);
                const duration = Math.floor((Date.now() - chatInfo.startTime) / 1000 / 60);
                this.activeChats.delete(clientId);
                if (this.currentClientId === clientId) {
                    this.currentClientId = null;
                }
                console.log(`Client disconnected: ${clientId}`);
                // Notify admin on Telegram
                this.bot.sendMessage(config.telegram.adminChatId,
                    `🔴 Client disconnected\n` +
                    `Client ID: ${clientId}\n` +
                    `Duration: ${duration} minutes\n` +
                    `Messages: ${chatInfo.messageCount}`
                );
            }
        }
    }
    
    sendMessageToClient(clientId, message, messageId) {
        const client = this.clients.get(clientId);
        if (!client || client.ws.readyState !== WebSocket.OPEN) {
            return false;
        }
        const data = {
            type: 'support_message',
            message: message,
            timestamp: Date.now(),
            messageId: messageId // Add messageId for tracking
        };
        client.ws.send(JSON.stringify(data), (err) => {
            if (!err && messageId) {
                // Mark as delivered and notify admin
                const pending = this.pendingMessages.get(messageId);
                if (pending) {
                    pending.status = 'delivered';
                    // Remove clientId from notification
                    this.bot.sendMessage(config.telegram.adminChatId, `📬 Delivered: ${pending.text}`);
                }
            }
        });
        return true;
    }

    sendImageToClient(clientId, dataUrl, messageId) {
        const client = this.clients.get(clientId);
        if (!client || client.ws.readyState !== WebSocket.OPEN) {
            return false;
        }
        const data = {
            type: 'support_image',
            dataUrl: dataUrl,
            timestamp: Date.now(),
            messageId: messageId
        };
        client.ws.send(JSON.stringify(data), (err) => {
            if (!err && messageId) {
                const pending = this.pendingMessages.get(messageId);
                if (pending) {
                    pending.status = 'delivered';
                    this.bot.sendMessage(config.telegram.adminChatId, `📬 Delivered: [Image]`);
                }
            }
        });
        return true;
    }
    
    extractClientIdFromMessage(message) {
        const match = message.match(/Message from (.+):/);
        return match ? match[1] : null;
    }
    
    startServer() {
        this.server.listen(config.port, () => {
            console.log(`Server running on port ${config.port}`);
            console.log(`WebSocket server ready`);
            console.log(`Make sure to set your Telegram bot token and chat ID in the config`);
        });
    }
}

// Start the server
new ChatServer();
