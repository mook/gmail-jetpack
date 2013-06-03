"use strict";

const self = require("self");
const {storage} = require("sdk/simple-storage");
const {Account} = require("./account");

let accounts = {};

require("sdk/passwords").search({
    url: "https://accounts.google.com",
    onComplete: function (logins) {
        for (let login of logins) {
            accounts[login.username] = new Account(login.username);
        }
    }
});

new (require("./settings").Settings)(accounts);
