const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// Express 및 웹 서버 초기화
const app = express();
const server = http.createServer(app);

// 이미지 전송을 위해 최대 버퍼 사이즈를 10MB로 넉넉하게 늘려줍니다.
const io = new Server(server, { 
    maxHttpBufferSize: 1e7,
    pingTimeout: 60000 // 연결 끊김 방지용 타임아웃 증가
});

app.use(express.static('public'));

// ---------------------------------------------------------
// 전역 상태 관리 (메모리 데이터베이스 역할)
// ---------------------------------------------------------
const rooms = {}; 
const userProfiles = {}; 
const profileImages = ['blue.png', 'gray.png', 'yellow.png', 'purple.png'];

// 스팸 필터링을 위한 유저별 마지막 메시지 시간 기록
const userRateLimits = {};

// 강력한 금지어 필터
const badWords = [
    '시발', '씨발', '병신', '새끼', '존나', '개새끼', 
    '미친', '지랄', '니애미', '느금', '애미', '애비'
];

// 욕설을 감지하여 착한 말로 바꿔주는 함수
function filterProfanity(text) {
    if(!text) return text;
    let filtered = text;
    badWords.forEach(word => {
        // 대소문자 구분 없이 모든 금지어를 찾아냅니다.
        const regex = new RegExp(word, 'gi');
        filtered = filtered.replace(regex, '❤️고운말❤️');
    });
    return filtered;
}

// IP 주소 파싱 (디시인사이드 스타일 닉네임용)
function getIpPrefix(ip) {
    if (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') return '127.0';
    const cleanIp = ip.includes('::ffff:') ? ip.split('::ffff:') : ip;
    const parts = cleanIp.split('.');
    return parts.length >= 2 ? `${parts}.${parts}` : 'IP';
}

// 클라이언트에게 보낼 안전한 방 목록 데이터 생성
function getRoomList() {
    const clientRooms = {};
    for (const [title, room] of Object.entries(rooms)) {
        clientRooms[title] = {
            isLocked: !!room.password, 
            userCount: Object.keys(room.users).length,
            lastMessage: room.lastMessage, 
            lastMessageTime: room.lastMessageTime, 
            isSandbox: room.isSandbox
        };
    }
    return clientRooms;
}

// ---------------------------------------------------------
// 소켓 통신 로직 시작
// ---------------------------------------------------------
io.on('connection', (socket) => {
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const ipPrefix = getIpPrefix(clientIp);
    let currentRoom = '';

    console.log(`[접속] 새로운 클라이언트 연결됨: ${socket.id} (IP: ${ipPrefix})`);

    // 1. 유저 로그인 처리
    socket.on('login', (nickname) => {
        // 닉네임 욕설 검사
        if (badWords.some(word => nickname.includes(word))) {
            return socket.emit('error_msg', '부적절한 단어가 포함된 닉네임은 사용할 수 없습니다.');
        }
        
        // 닉네임 길이 제한 방어 (서버단)
        const safeNickname = nickname.substring(0, 10);
        const fullNickname = `${safeNickname}(${ipPrefix})`;
        const randomProfile = profileImages[Math.floor(Math.random() * profileImages.length)];
        
        userProfiles[socket.id] = { 
            name: fullNickname, 
            profile: randomProfile, 
            rawName: safeNickname 
        };
        
        socket.emit('login_success', userProfiles[socket.id]);
        socket.emit('update_rooms', getRoomList());
    });

    // 2. 방 생성 로직
    socket.on('create_room', ({ title, password, isSandbox }) => {
        const safeTitle = title.substring(0, 20); // 방 제목 길이 제한
        if (rooms[safeTitle]) {
            return socket.emit('error_msg', '이미 존재하는 방 이름입니다. 다른 이름을 사용해주세요.');
        }
        
        rooms[safeTitle] = { 
            password: password || null, 
            host: socket.id, 
            users: {}, 
            lastMessage: '🎉 방이 생성되었습니다!', 
            lastMessageTime: new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}), 
            isSandbox: isSandbox, 
            sandboxEffects: [] 
        };
        
        io.emit('update_rooms', getRoomList());
        socket.emit('room_created', safeTitle);
        console.log(`[방 생성] ${safeTitle} (샌드박스: ${isSandbox})`);
    });

    // 3. 방 입장 로직
    socket.on('join_room', ({ title, password }) => {
        const room = rooms[title];
        if (!room) return socket.emit('error_msg', '존재하지 않거나 삭제된 방입니다.');
        
        if (room.password && room.password !== password) {
            return socket.emit('error_msg', '비밀번호가 일치하지 않습니다.');
        }

        // 기존에 있던 방에서 나가기
        if (currentRoom) leaveCurrentRoom();
        
        socket.join(title);
        currentRoom = title;
        room.users[socket.id] = userProfiles[socket.id];

        // 입장 성공 정보 전송 (기존 이펙트 데이터 포함)
        socket.emit('join_success', { 
            title, 
            isHost: room.host === socket.id, 
            users: room.users,
            isSandbox: room.isSandbox, 
            effects: room.sandboxEffects 
        });
        
        // 방 안에 있는 사람들에게만 내 입장 알림
        io.to(title).emit('room_users_update', { users: room.users, host: room.host });
        socket.to(title).emit('toast_message', `👋 ${userProfiles[socket.id].name}님이 입장하셨습니다.`);
        
        // 로비 인원수 업데이트
        io.emit('update_rooms', getRoomList());
    });

    // 4. 일반 메시지 및 이미지 전송 로직 (서버단 도배 방지 적용)
    socket.on('send_message', (msgData) => {
        if (!currentRoom) return;
        
        // 서버단 스팸 체크 (0.5초 이내 연속 전송 무시)
        const now = Date.now();
        if (userRateLimits[socket.id] && now - userRateLimits[socket.id] < 500) {
            return; // 조용히 무시
        }
        userRateLimits[socket.id] = now;

        const room = rooms[currentRoom];
        
        // 텍스트일 경우에만 욕설 필터링 적용
        if (msgData.type === 'text') {
            msgData.text = filterProfanity(msgData.text);
        }
        
        // 로비에 표시할 마지막 메시지 업데이트
        room.lastMessage = msgData.type === 'image' ? '📸 (사진)' : msgData.text;
        room.lastMessageTime = msgData.time;

        const broadcastData = { ...msgData, senderInfo: userProfiles[socket.id] };
        
        // 나를 제외한 방 사람들에게 전송
        socket.to(currentRoom).emit('chat_message', broadcastData);
        // 내 화면에 렌더링하기 위해 나에게도 전송
        socket.emit('message_filtered', broadcastData);
        
        // 로비 업데이트
        io.emit('update_rooms', getRoomList()); 
    });

    // 5. 공감(리액션) 중계
    socket.on('toggle_reaction', ({ msgId, emoji }) => {
        if (currentRoom) {
            io.to(currentRoom).emit('reaction_updated', { msgId, emoji, userId: socket.id });
        }
    });

    // 6. 메시지 삭제 중계
    socket.on('delete_message', (msgId) => {
        if (currentRoom) io.to(currentRoom).emit('message_deleted', msgId);
    });

    // 7. 타이핑 인디케이터
    socket.on('typing', (isTyping) => {
        if (currentRoom) {
            socket.to(currentRoom).emit('user_typing', { user: userProfiles[socket.id].rawName, isTyping });
        }
    });

    // 8. 방장 강제 퇴장 시스템
    socket.on('kick_user', (targetSocketId) => {
        const room = rooms[currentRoom];
        if (room && room.host === socket.id) {
            // 타겟 유저에게 강퇴 알림 전송
            io.to(targetSocketId).emit('kicked', '🚨 방장에 의해 강제 퇴장당했습니다.');
            
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (targetSocket) {
                targetSocket.leave(currentRoom); 
                delete room.users[targetSocketId];
                
                // 남은 사람들에게 알림
                io.to(currentRoom).emit('toast_message', `⚔️ 방장이 유저를 강제 퇴장시켰습니다.`);
                io.to(currentRoom).emit('room_users_update', { users: room.users, host: room.host });
                io.emit('update_rooms', getRoomList());
            }
        }
    });

    // 9. 파티 효과 등 전체 화면 이펙트
    socket.on('trigger_effect', (effectType) => { 
        if (currentRoom) io.to(currentRoom).emit('play_effect', effectType); 
    });

    // ---------------------------------------------------------
    // ⚔️ 샌드박스 (물리 엔진) 전용 소켓 이벤트
    // ---------------------------------------------------------
    
    // 이펙트 그리기 추가
    socket.on('add_sandbox_effect', (eff) => {
        if (currentRoom && rooms[currentRoom].isSandbox) {
            eff.owner = socket.id; 
            // 방 폭파 시 날아가지 않도록 서버 메모리에 저장
            rooms[currentRoom].sandboxEffects.push(eff); 
            // 다른 사람들에게 그리기 명령 전송
            socket.to(currentRoom).emit('draw_effect', eff);
        }
    });

    // 정밀 절단 애니메이션 
    socket.on('cut_message', (data) => { 
        if (currentRoom && rooms[currentRoom].isSandbox) {
            socket.to(currentRoom).emit('message_cut_anim', data); 
        }
    });
    
    // 총기 크랙 애니메이션
    socket.on('crack_message', (data) => { 
        if (currentRoom && rooms[currentRoom].isSandbox) {
            socket.to(currentRoom).emit('message_crack_anim', data); 
        }
    });
    
    // 폭탄 폭발(날리기) 애니메이션
    socket.on('blow_messages', (data) => { 
        if (currentRoom && rooms[currentRoom].isSandbox) {
            socket.to(currentRoom).emit('messages_blown_anim', data); 
        }
    });

    // 지우개로 이펙트 삭제
    socket.on('remove_sandbox_effect', (effectId) => {
        if (currentRoom && rooms[currentRoom].isSandbox) {
            const room = rooms[currentRoom];
            const idx = room.sandboxEffects.findIndex(e => e.id === effectId);
            
            if (idx !== -1) {
                const eff = room.sandboxEffects[idx];
                // 방장이거나, 자기가 만든 효과일 때만 삭제 허용
                if (room.host === socket.id || eff.owner === socket.id) {
                    room.sandboxEffects.splice(idx, 1); 
                    io.to(currentRoom).emit('erase_effect', effectId);
                }
            }
        }
    });

    // 방장 전용 전체 지우개
    socket.on('clear_all_sandbox', () => {
        if (currentRoom && rooms[currentRoom].isSandbox && rooms[currentRoom].host === socket.id) {
            rooms[currentRoom].sandboxEffects = []; 
            io.to(currentRoom).emit('clear_all_effects');
        }
    });

    // ---------------------------------------------------------
    // 방 퇴장 및 연결 해제 로직
    // ---------------------------------------------------------
    function leaveCurrentRoom() {
        if (currentRoom && rooms[currentRoom]) {
            const isHost = (rooms[currentRoom].host === socket.id);

            if (isHost) {
                // 방장이 나가면 방을 폭파시킵니다.
                socket.to(currentRoom).emit('room_closed', '💣 방장이 퇴장하여 방이 폭파되었습니다.');
                
                // 방에 있는 모든 유저의 소켓을 방에서 강제로 빼냅니다.
                const socketsInRoom = io.sockets.adapter.rooms.get(currentRoom);
                if (socketsInRoom) {
                    for (const socketId of socketsInRoom) {
                        const targetSocket = io.sockets.sockets.get(socketId);
                        if(targetSocket) targetSocket.leave(currentRoom);
                    }
                }
                // 메모리에서 방 삭제
                delete rooms[currentRoom];
                console.log(`[방 폭파] ${currentRoom}`);
            } else {
                // 일반 유저가 나갈 경우
                delete rooms[currentRoom].users[socket.id];
                socket.leave(currentRoom);
                
                // 남은 사람들에게 퇴장 알림
                socket.to(currentRoom).emit('toast_message', `🏃 ${userProfiles[socket.id].name}님이 퇴장하셨습니다.`);
                socket.to(currentRoom).emit('room_users_update', { users: rooms[currentRoom].users, host: rooms[currentRoom].host });
            }
            
            io.emit('update_rooms', getRoomList());
            currentRoom = '';
        }
    }
    
    socket.on('leave_room', leaveCurrentRoom);
    
    socket.on('disconnect', () => { 
        leaveCurrentRoom(); 
        delete userProfiles[socket.id]; 
        delete userRateLimits[socket.id];
    });
});

// 포트 3000으로 다시 원상복구했습니다.
const PORT = 3000;
server.listen(PORT, () => { 
    console.log(`=========================================`);
    console.log(`🔥 Chattrix V3 Server Running on Port ${PORT} 🔥`);
    console.log(`=========================================`);
});