"use strict";

const self = require("self");
const {storage} = require("sdk/simple-storage");
const {Account} = require("./account");

// XXX Mook for now, just do every account; we'll do something smarter later
require("sdk/passwords").search({
    url: "https://accounts.google.com",
    onComplete: function (logins) {
        for (let login of logins) {
            new Account(login.username);
        }
    }
});

