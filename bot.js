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
  "ti kruti",
  "ti kitu",
  "ti posran",
  "te nosam",
  "te pipo",
  "ti u smecu",
  "ti u smeću",
  "ti ga metnem",
  "mom si visia",
  "govno jesi",
  "mi kitu",
  "mi kruti",
  "si nosan"
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

// Custom user agent to simulate a real browser session
const loginOptions = {
  appState: appState
};

login(loginOptions, (err, api) => {
  if (err) {
    console.error("Login failed. Your appState/cookies have likely expired or been invalidated by Facebook.");
    console.error("Error details:", err);
    process.exit(1);
  }

  // Save/update refreshed appState locally
  try {
    const updatedAppState = api.getAppState();
    fs.writeFileSync("./appstate.json", JSON.stringify(updatedAppState, null, 2));
    console.log("Successfully logged in! Fresh appState saved to ./appstate.json.");
  } catch (saveErr) {
    console.error("Failed to save updated appState:", saveErr);
  }

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

  // 1. CHECK FOR PENDING VAR REVIEW DECISION (DOMINIK PAVEL)
  if (pendingVarReviews.has(threadID)) {
    const review = pendingVarReviews.get(threadID);

    if (senderID === review.dominikID || review.isDominikPavel) {
      if (messageText.includes("kick")) {
        pendingVarReviews.delete(threadID);

        const foulMsg = {};
        const foulGif = getRandomGif("var-foul");
        if (foulGif) foulMsg.attachment = fs.createReadStream(foulGif);

        api.sendMessage(foulMsg, threadID);

        api.changeNickname(review.cleanNickname, threadID, review.targetUserID, (err) => {
          if (err) console.error("Failed to clean nickname before kick:", err);

          api.removeUserFromGroup(review.targetUserID, threadID, (err) => {
            if (err) console.error("Failed to kick user after VAR review:", err);
            saveBan(review.targetUserID, threadID, Date.now() + BAN_DURATION_MS);
          });
        });

        return;
      }

      if (messageText.includes("pusti")) {
        pendingVarReviews.delete(threadID);

        const passMsg = {};
        const passGif = getRandomGif("var-pass");
        if (passGif) passMsg.attachment = fs.createReadStream(passGif);

        api.sendMessage(passMsg, threadID);

        return;
      }
    }
  }

  // 2. CHECK FOR "VAR" CALL
  const words = messageText.split(/\s+/);
  if (words.includes("var") || messageText === "var") {
    if (pendingKicks.has(threadID)) {
      const pending = pendingKicks.get(threadID);
      
      clearTimeout(pending.timeout);
      pendingKicks.delete(threadID);

      api.changeNickname(pending.yellowNickname, threadID, pending.userID);

      api.getThreadInfo(threadID, (err, info) => {
        let dominikID = null;
        if (!err && info && info.userInfo) {
          const dominik = info.userInfo.find(u => 
            u.name && u.name.toLowerCase().includes("dominik pavel")
          );
          if (dominik) dominikID = dominik.id;
        }

        pendingVarReviews.set(threadID, {
          targetUserID: pending.userID,
          cleanNickname: pending.cleanNickname,
          yellowNickname: pending.yellowNickname,
          redNickname: pending.redNickname,
          dominikID: dominikID,
          isDominikPavel: true
        });

        const msg = {
          body: "@Dominik Pavel",
          mentions: dominikID ? [{ tag: "@Dominik Pavel", id: dominikID }] : []
        };

        const varGif = getRandomGif("var-check");
        if (varGif) msg.attachment = fs.createReadStream(varGif);

        api.sendMessage(msg, threadID, (err) => {
          if (err) console.error("Failed to send VAR message:", err);
        });
      });

      return;
    }
  }

  // 3. CHECK FOR FORBIDDEN PHRASES
  const triggered = FORBIDDEN_PHRASES.some(phrase => messageText.includes(phrase));
  if (!triggered) return;

  api.getThreadInfo(threadID, (err, info) => {
    if (err) return console.error("Failed to get thread info:", err);

    const nicknames = info.nicknames || {};
    const currentNickname = nicknames[senderID] || "";

    const userObj = info.userInfo ? info.userInfo.find(u => u.id === senderID) : null;
    const fullName = userObj ? userObj.name : "";

    if (currentNickname.includes(YELLOW_CARD)) {
      if (pendingKicks.has(threadID)) {
        clearTimeout(pendingKicks.get(threadID).timeout);
      }

      const cleanNickname = currentNickname.replace(YELLOW_CARD, "").replace(RED_CARD, "").trim() || fullName;
      const redNickname = `${cleanNickname} ${RED_CARD}`.trim();

      api.changeNickname(redNickname, threadID, senderID, (err) => {
        if (err) console.error("Failed to set red card nickname:", err);
      });

      const redMsg = {};
      const redGif = getRandomGif("red");
      if (redGif) redMsg.attachment = fs.createReadStream(redGif);

      api.sendMessage(redMsg, threadID);

      const timeout = setTimeout(() => {
        pendingKicks.delete(threadID);

        api.changeNickname(cleanNickname, threadID, senderID, (err) => {
          if (err) console.error("Failed to clean nickname before kick:", err);

          api.removeUserFromGroup(senderID, threadID, (err) => {
            if (err) console.error("Failed to kick user:", err);
            saveBan(senderID, threadID, Date.now() + BAN_DURATION_MS);
          });
        });
      }, KICK_DELAY_MS);

      pendingKicks.set(threadID, { 
        userID: senderID, 
        timeout, 
        yellowNickname: currentNickname, 
        cleanNickname,
        redNickname 
      });

    } else {
      const baseName = currentNickname || fullName || "User";
      const newNickname = `${baseName} ${YELLOW_CARD}`;
      
      api.changeNickname(newNickname, threadID, senderID, (err) => {
        if (err) return console.error("Failed to set nickname:", err);

        const yellowMsg = {};
        const yellowGif = getRandomGif("yellow");
        if (yellowGif) yellowMsg.attachment = fs.createReadStream(yellowGif);

        api.sendMessage(yellowMsg, threadID);
      });
    }
  });
}

function saveBan(userID, threadID, unbanTime) {
  const bans = JSON.parse(fs.readFileSync(BANS_FILE, "utf8"));
  bans.push({ userID, threadID, unbanTime });
  fs.writeFileSync(BANS_FILE, JSON.stringify(bans, null, 2));
}

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