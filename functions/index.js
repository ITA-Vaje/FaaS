const {onRequest} = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const nodemailer = require("nodemailer");

const express = require("express");
const app = express();
app.use(express.json());


admin.initializeApp();

const db = admin.firestore();

exports.registerUser = onRequest(async (req, res) => {
  const { email, password, username } = req.body;

  if (!email || !password || !username) {
    res.status(400).send("Email, password, and username are required.");
    return;
  }

  try {
    // Create the user in Firebase Auth
    const userRecord = await admin.auth().createUser({
      email,
      password,
    });

    // Save the username in Firestore under the user's UID
    await admin.firestore().collection('users').doc(userRecord.uid).set({
      email,
      username,
      createdAt: new Date().toISOString(),
    });

    res.status(201).send({ message: "User created", uid: userRecord.uid });
  } catch (error) {
    logger.error("Error creating user:", error);
    res.status(500).send({ error: error.message });
  }
});

exports.submitPrediction = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const idToken = req.headers.authorization?.split("Bearer ")[1];
  if (!idToken) {
    return res.status(401).send("Missing auth token");
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;
    //const uid = "test-user-223"; 
    const { raceId, prediction } = req.body;

    if (!raceId || !prediction || !prediction.p1 || !prediction.p2 || !prediction.p3) {
      return res.status(400).send("Missing raceId or prediction (p1, p2, p3)");
    }

    const docId = `${raceId}_${uid}`;

    await db.collection("predictions").doc(docId).set({
      uid,
      raceId,
      prediction,
      timestamp: new Date().toISOString()
    });

    res.status(200).send({ message: "Prediction submitted successfully" });
  } catch (error) {
    logger.error("Error submitting prediction:", error);
    res.status(500).send({ error: error.message });
  }
});

exports.updateRaceResult = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const idToken = req.headers.authorization?.split("Bearer ")[1];
  if (!idToken) {
    return res.status(401).send("Missing auth token");
  }

  const decodedToken = await admin.auth().verifyIdToken(idToken);
  if (!decodedToken.admin) {
    return res.status(403).send("Forbidden: Admin access only");
  }

  const { raceId, result } = req.body;

  if (!raceId || !result || !result.p1 || !result.p2 || !result.p3) {
    return res.status(400).send("Missing raceId or result (p1, p2, p3)");
  }

  try {
    await admin.firestore().collection("results").doc(raceId).set({
      result,
      timestamp: new Date().toISOString(),
    });

    res.status(200).send({ message: "Race result updated" });
  } catch (error) {
    logger.error("Error updating race result:", error);
    res.status(500).send({ error: error.message });
  }
});

exports.calculateUserScores = onDocumentWritten("results/{raceId}", async (event) => {
  const raceId = event.params.raceId;
  const afterData = event.data?.after?.data();

  if (!afterData) {
    logger.info(`Result deleted for race: ${raceId}, skipping score calculation.`);
    return;
  }

  const actual = afterData.result;
  logger.info(`Calculating scores for race: ${raceId}`, actual);

  try {
    const predictionsSnapshot = await db.collection("predictions")
      .where("raceId", "==", raceId)
      .get();

    const batch = db.batch();

    predictionsSnapshot.forEach((doc) => {
      const predictionData = doc.data();
      const pred = predictionData.prediction;
      const uid = predictionData.uid;

      let score = 0;
      ["p1", "p2", "p3"].forEach((pos) => {
        if (pred[pos] === actual[pos]) {
          score += 3;
        } else if (Object.values(actual).includes(pred[pos])) {
          score += 1;
        }
      });

      const scoreRef = db.collection("scores").doc(`${uid}_${raceId}`);
      batch.set(scoreRef, {
        uid,
        raceId,
        score,
        timestamp: new Date().toISOString(),
      });
    });

    await batch.commit();
    logger.info(`Scores calculated and saved for race: ${raceId}`);
  } catch (error) {
    logger.error("Error calculating scores:", error);
  }
});

exports.getLeaderboard = onRequest(async (req, res) => {
  const idToken = req.headers.authorization?.split("Bearer ")[1];

  if (!idToken) {
    return res.status(401).send("Missing auth token");
  }

  try {
    await admin.auth().verifyIdToken(idToken);
  } catch (error) {
    return res.status(401).send("Invalid or expired token");
  }

  try {
    const scoresSnapshot = await db.collection("scores").get();
    const leaderboard = {};

    // Aggregate scores by UID
    scoresSnapshot.forEach((doc) => {
      const { uid, score } = doc.data();
      if (!leaderboard[uid]) {
        leaderboard[uid] = 0;
      }
      leaderboard[uid] += score;
    });

    // Get UIDs and fetch usernames
    const uids = Object.keys(leaderboard);
    const userDocs = await Promise.all(
      uids.map(uid => db.collection("users").doc(uid).get())
    );

    const uidToUsername = {};
    userDocs.forEach(doc => {
      if (doc.exists) {
        uidToUsername[doc.id] = doc.data().username || doc.id;
      } else {
        uidToUsername[doc.id] = doc.id; // fallback to UID
      }
    });

    // Build and sort leaderboard with usernames
    const sorted = uids
      .map(uid => ({
        uid,
        username: uidToUsername[uid],
        totalScore: leaderboard[uid]
      }))
      .sort((a, b) => b.totalScore - a.totalScore);

    res.status(200).send({ leaderboard: sorted });
  } catch (error) {
    logger.error("Error fetching leaderboard:", error);
    res.status(500).send({ error: error.message });
  }
});


exports.addRace = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const idToken = req.headers.authorization?.split("Bearer ")[1];
  if (!idToken) {
    return res.status(401).send("Missing auth token");
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const isAdmin = decodedToken.admin === true;

    if (!isAdmin) {
      return res.status(403).send("Access denied: Admins only");
    }

    const { raceName, raceDate, location, round } = req.body;

    if (!raceName || !raceDate) {
      return res.status(400).send("Missing required fields: raceName and raceDate");
    }

    const raceData = {
      raceName,
      raceDate: new Date(raceDate), // should be ISO string or Date
      location: location || null,
      round: round || null,
      createdAt: new Date().toISOString(),
    };

    const newRaceRef = await db.collection("races").add(raceData);
    res.status(201).send({ message: "Race added", raceId: newRaceRef.id });

  } catch (error) {
    logger.error("Error adding race:", error);
    res.status(500).send({ error: error.message });
  }
});

exports.getRaces = onRequest(async (req, res) => {
  const idToken = req.headers.authorization?.split("Bearer ")[1];

  if (!idToken) {
    return res.status(401).send("Missing auth token");
  }

  try {
    await admin.auth().verifyIdToken(idToken);
  } catch (error) {
    return res.status(401).send("Invalid or expired token");
  }

  try {
    const snapshot = await db.collection("races").orderBy("raceDate").get();

    const races = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).send({ races });
  } catch (error) {
    logger.error("Error fetching races:", error);
    res.status(500).send({ error: error.message });
  }
});

exports.addDriver = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const idToken = req.headers.authorization?.split("Bearer ")[1];
  if (!idToken) {
    return res.status(401).send("Missing auth token");
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    if (!decodedToken.admin) {
      return res.status(403).send("Forbidden: Admin access only");
    }

    const { name, team, country } = req.body;
    if (!name || !team || !country) {
      return res.status(400).send("Missing required fields: name, team, country");
    }

    const newDriver = {
      name,
      team,
      country,
      createdAt: new Date().toISOString(),
    };

    const driverRef = await admin.firestore().collection("drivers").add(newDriver);

    res.status(201).send({ message: "Driver added", driverId: driverRef.id });
  } catch (error) {
    logger.error("Error adding driver:", error);
    res.status(500).send({ error: error.message });
  }
});

exports.updateDriver = onRequest({ cors: true }, async (req, res) => {
  const id = req.params.id;
  const { name, team, country } = req.body;

  try {
    await setDoc(doc(db, 'drivers', id), { name, team, country }, { merge: true });
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update driver' });
  }
});


exports.getDrivers = onRequest(async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const snapshot = await admin.firestore().collection("drivers").orderBy("name").get();
    const drivers = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).send({ drivers });
  } catch (error) {
    logger.error("Error fetching drivers:", error);
    res.status(500).send({ error: error.message });
  }
});


exports.sendPredictionReminder = onSchedule(
  {
    schedule: "every 2 minutes", 
    timeZone: "Europe/Ljubljana", 
  },
  async (event) => {
    logger.info("Running scheduled reminder function...");

    const now = new Date();
    const next24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // 1. Find races within next 24h
    const racesSnapshot = await db.collection("races")
      .where("raceDate", ">=", now)
      .where("raceDate", "<=", next24h)
      .get();

    if (racesSnapshot.empty) {
      logger.info("No upcoming races in the next 24h.");
      return;
    }

    // 2. Get all users
    const listUsers = await admin.auth().listUsers();
    const emails = listUsers.users.map(user => user.email).filter(Boolean);

    // 3. Send emails
    const transporter = nodemailer.createTransport({
      service: "gmail", // or use your SMTP provider
      auth: {
        user: "your-email@gmail.com",
        pass: "your-app-password",
      },
    });

    const sendPromises = emails.map(email => {
      return transporter.sendMail({
        from: '"F1 Predictor" <your-email@gmail.com>',
        to: email,
        subject: "Reminder: Submit your race prediction!",
        text: `There's a race coming up in the next 24h. Submit your prediction now!`,
      });
    });

    await Promise.all(sendPromises);
    logger.info(`Sent reminders to ${emails.length} users.`);
  }
);
