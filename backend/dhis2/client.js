const axios = require("axios");

const dhis2Client = axios.create({
  baseURL: process.env.DHIS2_URL,
  auth: {
    username: process.env.DHIS2_USERNAME,
    password: process.env.DHIS2_PASSWORD
  },
  headers: {
    "Content-Type": "application/json"
  }
});

module.exports = dhis2Client;O

