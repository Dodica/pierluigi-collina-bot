const { login } = require("@dongdev/fca-unofficial");
const fs = require("fs");
const path = require("path");

// Keep-alive HTTP server for Render deployment
const http = require("http");
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Collina Bot is active!");
}).listen(PORT, () => console.log(`HTTP health check running on port ${PORT}`));

// Forbidden phrases (matches regardless of upper/lower case)
const FORBIDDEN_PHRASES = [
  "uleti ti kruti",
  "uvalim ti kitu",
  "nos ti posran",
  "na kurcu te nosam",
  "moj te pipo",
  "uvalim ti kruti"
];

const YELLOW_CARD = "🟨";
const RED_CARD = "🟥";
const BAN_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const KICK_DELAY_MS = 30 * 1000; // 30 seconds VAR window
const BANS_FILE = "./bans.json";

// Maps for tracking pending timers and active VAR reviews
const pendingKicks = new Map();       // Key: threadID -> 30-second kick timer
const pendingVarReviews = new Map();  // Key: threadID -> Waiting for Dominik Pavel's decision

// Helper function to pick randomly between base GIF and -2 GIF (50% chance each)
function getRandomGif(baseName) {
  const gif1 = path.join(__dirname, `${baseName}.gif`);
  const gif2 = path.join(__dirname, `${baseName}-2.gif`);

  const availableGifs = [gif1, gif2].filter(file => fs.existsSync(file));

  if (availableGifs.length === 0) return null;
  return availableGifs[Math.floor(Math.random() * availableGifs.length)];
}

// Initialize bans file if missing
if (!fs.existsSync(BANS_FILE)) {
  fs.writeFileSync(BANS_FILE, JSON.stringify([]));
}

// -------------------------------------------------------------
// LOAD APPSTATE (ENV VAR -> LOCAL FILE -> RENDER SECRET FILE)
// -------------------------------------------------------------
let appState = null;

if (process.env.APP_STATE) {
  try {
    appState = JSON.parse(process.env.APP_STATE);
    console.log("Loaded appState from process.env.APP_STATE.");
  } catch (err) {
    console.error("Failed to parse APP_STATE environment variable:", err);
  }
}

if (!appState && fs.existsSync("./appstate.json")) {
  try {
    appState = JSON.parse(fs.readFileSync("./appstate.json", "utf8"));
    console.log("Loaded appState from ./appstate.json.");
  } catch (err) {
    console.error("Failed to parse ./appstate.json:", err);
  }
}

if (!appState && fs.existsSync("/etc/secrets/appstate.json")) {
  try {
    appState = JSON.parse(fs.readFileSync("/etc/secrets/appstate.json", "utf8"));
    console.log("Loaded appState from /etc/secrets/appstate.json.");
  } catch (err) {
    console.error("Failed to parse /etc/secrets/appstate.json:", err);
  }
}

if (!appState) {
  console.error("Error: appstate configuration missing! Add APP_STATE env var or appstate.json file.");
  process.exit(1);
}

login({ appState }, (err, api) => {
  if (err) return console.error("Login failed:", err);

  console.log("Pierluigi Collina Referee Bot (Full VAR System) is active!");
  api.setOptions({ listenEvents: true, selfListen: false });

  // Check background loop every 60s to re-add users whose 24h ban expired
  setInterval(() => checkAndUnbanUsers(api), 60 * 1000);

  api.listenMqtt((err, event) => {
    if (err) return console.error("Listener error:", err);
    if (event.type === "message" && event.body) {
      handleRefereeLogic(api, event);
    }
  });
});

function handleRefereeLogic(api, event) {
  const { body, threadID, senderID } = event;
  const messageText = body.trim().toLowerCase();

  // -------------------------------------------------------------
  // 1. CHECK FOR PENDING VAR REVIEW DECISION (DOMINIK PAVEL)
  // -------------------------------------------------------------
  if (pendingVarReviews.has(threadID)) {
    const review = pendingVarReviews.get(threadID);

    // Verify if message is sent by Dominik Pavel
    if (senderID === review.dominikID || review.isDominikPavel) {
      
      // OPTION A: DECISION IS "KICK"
      if (messageText.includes("kick")) {
        pendingVarReviews.delete(threadID);

        // Reapply Red Card Emoji (🟥)
        api.changeNickname(review.redNickname, threadID, review.targetUserID);

        // Send var-foul.gif or var-foul-2.gif
        const foulMsg = {};
        const foulGif = getRandomGif("var-foul");
        if (foulGif) foulMsg.attachment = fs.createReadStream(foulGif);

        api.sendMessage(foulMsg, threadID);

        // Kick user immediately
        api.removeUserFromGroup(review.targetUserID, threadID, (err) => {
          if (err) console.error("Failed to kick user after VAR review:", err);
          saveBan(review.targetUserID, threadID, Date.now() + BAN_DURATION_MS);
        });

        return;
      }

      // OPTION B: DECISION IS "PUSTI"
      if (messageText.includes("pusti")) {
        pendingVarReviews.delete(threadID);

        // User stays on Yellow Card (🟨) - Red card cancelled!
        const passMsg = {};
        const passGif = getRandomGif("var-pass");
        if (passGif) passMsg.attachment = fs.createReadStream(passGif);

        api.sendMessage(passMsg, threadID);

        return;
      }
    }
  }

  // -------------------------------------------------------------
  // 2. CHECK FOR "VAR" CALL
  // -------------------------------------------------------------
  const words = messageText.split(/\s+/);
  if (words.includes("var") || messageText === "var") {
    if (pendingKicks.has(threadID)) {
      const pending = pendingKicks.get(threadID);
      
      // Stop the 30-second kick countdown
      clearTimeout(pending.timeout);
      pendingKicks.delete(threadID);

      // Revert nickname back to Yellow Card (🟨) during VAR review
      api.changeNickname(pending.yellowNickname, threadID, pending.userID);

      // Locate Dominik Pavel in thread participants
      api.getThreadInfo(threadID, (err, info) => {
        let dominikID = null;
        if (!err && info && info.userInfo) {
          const dominik = info.userInfo.find(u => 
            u.name && u.name.toLowerCase().includes("dominik pavel")
          );
          if (dominik) dominikID = dominik.id;
        }

        // Store active VAR review session
        pendingVarReviews.set(threadID, {
          targetUserID: pending.userID,
          cleanNickname: pending.cleanNickname,
          yellowNickname: pending.yellowNickname,
          redNickname: pending.redNickname,
          dominikID: dominikID,
          isDominikPavel: true // fallback matching
        });

        const msg = {
          body: "@Dominik Pavel",
          mentions: dominikID ? [{ tag: "@Dominik Pavel", id: dominikID }] : []
        };

        // Attach random var-check GIF
        const varGif = getRandomGif("var-check");
        if (varGif) msg.attachment = fs.createReadStream(varGif);

        api.sendMessage(msg, threadID, (err) => {
          if (err) console.error("Failed to send VAR message:", err);
        });
      });

      return;
    }
  }

  // -------------------------------------------------------------
  // 3. CHECK FOR FORBIDDEN PHRASES
  // -------------------------------------------------------------
  const triggered = FORBIDDEN_PHRASES.some(phrase => messageText.includes(phrase));
  if (!triggered) return;

  api.getThreadInfo(threadID, (err, info) => {
    if (err) return console.error("Failed to get thread info:", err);

    const nicknames = info.nicknames || {};
    const currentNickname = nicknames[senderID] || "";

    // CASE 1: USER ALREADY HAS YELLOW CARD -> CHANGE TO RED EMOJI & START 30s COUNTDOWN
    if (currentNickname.includes(YELLOW_CARD)) {
      if (pendingKicks.has(threadID)) {
        clearTimeout(pendingKicks.get(threadID).timeout);
      }

      const cleanNickname = currentNickname.replace(YELLOW_CARD, "").trim();
      const redNickname = `${cleanNickname} ${RED_CARD}`.trim();

      // Immediately change nickname to Red Card emoji (🟥)
      api.changeNickname(redNickname, threadID, senderID, (err) => {
        if (err) console.error("Failed to set red card nickname:", err);
      });

      // Send Red Card GIF (red.gif or red-2.gif)
      const redMsg = {};
      const redGif = getRandomGif("red");
      if (redGif) redMsg.attachment = fs.createReadStream(redGif);

      api.sendMessage(redMsg, threadID);

      // Start 30-second timer before kick
      const timeout = setTimeout(() => {
        pendingKicks.delete(threadID);

        // Clean nickname before kicking
        api.changeNickname(cleanNickname, threadID, senderID);

        // Kick user
        api.removeUserFromGroup(senderID, threadID, (err) => {
          if (err) console.error("Failed to kick user:", err);
          saveBan(senderID, threadID, Date.now() + BAN_DURATION_MS);
        });
      }, KICK_DELAY_MS);

      // Save active countdown details
      pendingKicks.set(threadID, { 
        userID: senderID, 
        timeout, 
        yellowNickname: currentNickname, 
        cleanNickname,
        redNickname 
      });

    // CASE 2: FIRST OFFENSE -> ADD YELLOW CARD EMOJI (🟨) & SEND YELLOW GIF
    } else {
      const newNickname = currentNickname ? `${currentNickname} ${YELLOW_CARD}` : `User ${YELLOW_CARD}`;
      
      api.changeNickname(newNickname, threadID, senderID, (err) => {
        if (err) return console.error("Failed to set nickname:", err);

        // Send Yellow Card GIF (yellow.gif or yellow-2.gif)
        const yellowMsg = {};
        const yellowGif = getRandomGif("yellow");
        if (yellowGif) yellowMsg.attachment = fs.createReadStream(yellowGif);

        api.sendMessage(yellowMsg, threadID);
      });
    }
  });
}

// Save ban info locally
function saveBan(userID, threadID, unbanTime) {
  const bans = JSON.parse(fs.readFileSync(BANS_FILE, "utf8"));
  bans.push({ userID, threadID, unbanTime });
  fs.writeFileSync(BANS_FILE, JSON.stringify(bans, null, 2));
}

// Check database every minute and re-add users whose ban expired
function checkAndUnbanUsers(api) {
  let bans = JSON.parse(fs.readFileSync(BANS_FILE, "utf8"));
  const now = Date.now();
  const remainingBans = [];

  bans.forEach(ban => {
    if (now >= ban.unbanTime) {
      api.addUserToGroup(ban.userID, ban.threadID, (err) => {
        if (err) {
          console.error(`Failed to re-add user ${ban.userID}:`, err);
        }
      });
    } else {
      remainingBans.push(ban);
    }
  });

  fs.writeFileSync(BANS_FILE, JSON.stringify(remainingBans, null, 2));
}