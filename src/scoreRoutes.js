const createAuthMiddleware = require('./middleware/auth.js');
const { v4: uuidv4 } = require('uuid');

const { evaluateAchievements, getAllAchievementDefinitions } = require('./achievementManager');
const { getGames } = require('./gameManager');

module.exports = (app, { userRepository, scoreRepository, redisManager }, jwtSecret) => {
    const authMiddleware = createAuthMiddleware(jwtSecret);
    app.get('/api/achievements', (req, res) => {
        try {
            const definitions = getAllAchievementDefinitions();
            res.json({ success: true, achievements: definitions });
        } catch (error) {
            console.error('Error fetching achievement definitions:', error);
            res.status(500).json({ success: false, message: '도전과제 목록을 불러오는 중 오류가 발생했습니다.' });
        }
    });

    app.post('/api/scores', async (req, res) => {
        const { gameId, score, userId, options, timestamp } = req.body;

        // Anonymous users cannot have their scores updated, so we just add them.
        if (userId === 'anonymous') {
            const anonScore = { id: uuidv4(), gameId, score, userId, options: options || {}, timestamp: timestamp || new Date().toISOString() };
            await scoreRepository.addScore(anonScore);
            await redisManager.persistScore(gameId, anonScore.id);
            return res.json({ success: true, score: anonScore });
        }

        const existingScores = await scoreRepository.getScores(gameId);

        const newScore = {
            id: uuidv4(),
            gameId,
            score,
            userId,
            options: options || {},
            timestamp: timestamp || new Date().toISOString(),
        };
        existingScores.push(newScore);
        await scoreRepository.saveScoresForGame(gameId, existingScores);
        await redisManager.persistGameScores(gameId);

        let unlockedAchievements = [];
        let newlyUnlockedEffects = [];
        let newlyUnlockedTitles = [];
        let currencyGained = 0;
        let finalUser = null;

        const currentUser = await userRepository.getUser(userId);
        if (currentUser) {
            const achievementResult = evaluateAchievements(currentUser, { gameId, ...options }, { score, ...options });
            const userToSave = achievementResult.updatedUser;

            currencyGained = Math.floor(score / 100);
            if (currencyGained > 0) {
                userToSave.money = (userToSave.money || 0) + currencyGained;
                const game = getGames().find(g => g.id === gameId);
                const gameName = game ? game.name : gameId;
                await userRepository.addTransaction(userId, {
                    description: `${gameName} 플레이 보상`,
                    amount: currencyGained,
                    type: 'earn'
                });
            }

            if (JSON.stringify(currentUser) !== JSON.stringify(userToSave)) {
                await userRepository.saveUser(userToSave);
                await redisManager.persistUser(userToSave.id);
            }
            
            finalUser = userToSave;
            unlockedAchievements = achievementResult.unlockedAchievements;
            newlyUnlockedEffects = achievementResult.newlyUnlockedEffects;
            newlyUnlockedTitles = achievementResult.newlyUnlockedTitles;
        }

        res.json({ success: true, score: newScore, unlockedAchievements, newlyUnlockedEffects, newlyUnlockedTitles, currencyGained, user: finalUser });
    });

    app.get('/api/rankings/money', async (req, res) => {
        try {
            const allUsers = await userRepository.getAllUsers();
            const moneyRanking = allUsers
                .filter(u => u.money !== undefined && u.money > 0)
                .sort((a, b) => b.money - a.money)
                .slice(0, 100) // Return top 100
                .map(u => ({
                    userId: u.id,
                    userName: u.name,
                    userAvatar: u.avatar,
                    score: u.money, // Use 'score' field for consistency on the frontend
                    userBirthday: u.birthday,
                    cardEffect: u.cardEffect,
                    cardDecoration: u.cardDecoration,
                }));
            res.json({ success: true, scores: moneyRanking });
        } catch (error) {
            console.error('Error fetching money ranking:', error);
            res.status(500).json({ success: false, message: '소지금 랭킹을 불러오는 중 오류가 발생했습니다.' });
        }
    });

    app.get('/api/scores/:gameId', async (req, res) => {
        const { gameId } = req.params;
        try {
            const allScores = await scoreRepository.getScores(gameId);
            const highestScores = {};
            for (const score of allScores) {
                if (score.userId === 'anonymous') {
                    highestScores[`anonymous-${score.id}`] = score;
                    continue;
                }
                if (!highestScores[score.userId] || score.score > highestScores[score.userId].score) {
                    highestScores[score.userId] = score;
                }
            }
            let scores = Object.values(highestScores);

            // Sort by score descending
            scores.sort((a, b) => b.score - a.score);

            // Populate user details for each score entry
            const scoresWithUserDetails = [];
            for (const scoreEntry of scores) {
                const userDetails = await userRepository.getUser(scoreEntry.userId);
                if (userDetails) {
                    scoresWithUserDetails.push({
                        ...scoreEntry,
                        userName: userDetails.name,
                        userAvatar: userDetails.avatar,
                        userBirthday: userDetails.birthday,
                        cardEffect: userDetails.cardEffect,
                        cardDecoration: userDetails.cardDecoration,
                    });
                } else {
                    const isAnonymous = scoreEntry.userId === 'anonymous';
                    scoresWithUserDetails.push({
                        ...scoreEntry,
                        userName: isAnonymous ? '익명' : '삭제된 계정',
                        userAvatar: `https://api.dicebear.com/8.x/bottts/svg?seed=${isAnonymous ? 'anonymous' : 'deleted'}`,
                        userBirthday: null,
                    });
                }
            }

            res.json({ success: true, scores: scoresWithUserDetails });
        } catch (error) {
            console.error('Error fetching scores:', error);
            res.status(500).json({ success: false, message: '점수를 불러오는 중 오류가 발생했습니다.' });
        }
    });

    app.delete('/api/scores/:scoreId', authMiddleware, async (req, res) => {
        if (!req.user || !req.user.isMaster) {
            return res.status(403).json({ success: false, message: '권한이 없습니다.' });
        }
        const { scoreId } = req.params;
        const { deleteAll } = req.body;
        const allGames = getGames();
        let scoreDeleted = false;
        for (const game of allGames) {
            const scores = await scoreRepository.getScores(game.id);
            const scoreIndex = scores.findIndex(s => s.id === scoreId);
            if (scoreIndex > -1) {
                const scoreToDelete = scores[scoreIndex];
                const userIdToDelete = scoreToDelete.userId;
                let newScores;

                if (deleteAll) {
                    newScores = scores.filter(s => s.userId !== userIdToDelete);
                } else {
                    newScores = scores.filter(s => s.id !== scoreId);
                }

                await scoreRepository.saveScoresForGame(game.id, newScores);
                await redisManager.persistGameScores(game.id);
                scoreDeleted = true;
                break;
            }
        }
        if (scoreDeleted) {
            res.json({ success: true, message: '랭킹이 삭제되었습니다.' });
        } else {
            res.status(404).json({ success: false, message: '해당 랭킹을 찾을 수 없습니다.' });
        }
    });

    app.post('/api/game-over', authMiddleware, async (req, res) => {
        const { gameId, score, userId } = req.body;
        if (!userId || userId === 'anonymous') {
            return res.json({ success: true, message: 'Anonymous user cannot earn currency.' });
        }

        try {
            const currentUser = await userRepository.getUser(userId);
            if (currentUser) {
                const currencyGained = Math.floor(score / 100);
                if (currencyGained > 0) {
                    currentUser.money = (currentUser.money || 0) + currencyGained;
                    const game = getGames().find(g => g.id === gameId);
                    const gameName = game ? game.name : gameId;
                    await userRepository.addTransaction(userId, {
                        description: `${gameName} 플레이 보상 (랭킹 미기록)`,
                        amount: currencyGained,
                        type: 'earn'
                    });
                    await userRepository.saveUser(currentUser);
                    await redisManager.persistUser(currentUser.id);
                }
                res.json({ success: true, user: currentUser, currencyGained });
            } else {
                res.status(404).json({ success: false, message: 'User not found' });
            }
        } catch (error) {
            console.error('Error processing game-over:', error);
            res.status(500).json({ success: false, message: 'Error processing game over.' });
        }
    });
};