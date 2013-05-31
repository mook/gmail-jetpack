"use strict";

const self = require("self");
const {storage} = require("sdk/simple-storage");
const passwords = require("sdk/passwords");
const {URL} = require("sdk/url");
const {Request} = require("./request");

/**
 * Data for a gmail account
 */
function Account(username) {
    this.username = username;
    console.log("Creating account:", this.username);
    this.button = require("toolbarbutton").ToolbarButton({
        id: self.id + ":toolbar:" + this.username,
        label: this.username,
        image: self.data.url("images/offline.png"),
        tooltiptext: this.username,
        onCommand: () => this.login(),
    });
    let seen = false;
    if (this.username in storage) {
        seen = true;
    } else {
        // new account
        storage[this.username] = {
            "auto-login": true,
        };
        this.button.moveTo({
            toolbarID: "addon-bar",
            forceMove: false,
        });
    }
    
    if (storage[this.username]["auto-login"]) {
        this.login();
    }
}

/**
 * Log in to this account
 * @param callback [optional] A function to be called on success
 * @note Nothing will be done on failure
 */
Account.prototype.login = function(callback) {
    const onHavePassword = (logins) => {
        let password = logins[0].password;
        console.log("Have password for", this.username, ": logging into",
                    this._loginURL);
        try {
            let req = new Request({
                url: this._loginURL,
                method: "POST",
            });
            console.log("got request", req);
        } catch(e) {
            console.exception(e);
        }
    };
    require("sdk/passwords").search({
        username: this.username,
        url: "https://accounts.google.com",
        onComplete: onHavePassword,
        onError: this._on_logout.bind(this),
    });
};

/**
 * Called when the account has been logged out
 */
Account.prototype._on_logout = function() {
    
};

/**
 * The domain of this account
 */
Object.defineProperty(Account.prototype, "domain", {
    get: function() this.username.replace(/^.*@/, ""),
    enumerable: true});

/**
 * The user name for this account
 */
Object.defineProperty(Account.prototype, "user", {
    get: function() this.username.replace(/@.*?$/, ""),
    enumerable: true});

/**
 * Whether this account is o Google Apps for Domain account
 */
Object.defineProperty(Account.prototype, "isHosted", {
    get: function() ["gmail.com", "googlemail.com"].indexOf(this.domain) >= 0,
    enumerable: true});

/**
 * The URL to use for logging in
 */
Object.defineProperty(Account.prototype, "_loginURL", {
    get: function() this.isHosted ?
        URL("https://www.google.com/a/" + this.domain + "/LoginAction2") :
        URL("https://www.google.com/accounts/ServiceLoginAuth"),
    enumerable: true});

/**
 * The URL to use for checking mail
 */
Object.defineProperty(Account.prototype, "_checkURL", {
    get: function() this.isHosted ?
        URL("https://mail.google.com/a/" + this.domain + "/") :
        URL("https://mail.google.com/mail/"),
    enumerable: true});

exports.Account = Account;
