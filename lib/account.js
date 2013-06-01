"use strict";

const self = require("self");
const { storage } = require("sdk/simple-storage");
const passwords = require("sdk/passwords");
const { Class } = require('sdk/core/heritage');
const { URL } = require("sdk/url");
const { RequestPromise } = require("./request");
const { CookieJar } = require("./cookiejar");
const { defer } = require("sdk/core/promise");

/**
 * Data for a gmail account
 */
const Account = exports.Account = Class({
    initialize: function (username) {
        this.username = username;
        console.log("Creating account:", this.username);
        this.cookiejar = new CookieJar();
        this.button = require("toolbarbutton").ToolbarButton({
            id: self.id + ":toolbar:" + this.username,
            label: this.username,
            image: self.data.url("images/offline.png"),
            tooltiptext: this.username,
            onCommand: () => this.login(),
        });
        if (!(this.username in storage)) {
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
    },

    /**
     * Log in to this account
     * @param callback [optional] A function to be called on success
     * @note Nothing will be done on failure
     */
    login: function(callback) {
        let deferred = defer();
        
        require("sdk/passwords").search({
            username: this.username,
            url: "https://accounts.google.com",
            onComplete: deferred.resolve,
            onError: deferred.reject,
        });

        deferred.promise.then((logins) => {
            let password = logins[0].password;
            console.log("Have password for", this.username, ": logging into",
                        this._loginURL);
            return RequestPromise({
                    url: this._loginURL,
                    method: "GET",
                    cookiejar: this.cookiejar,
            });
        }).then((doc) => {
            let form = doc.querySelector('form[action][method]');
            for (let input of form.querySelectorAll('input')) {
                console.log(input.getAttribute("name"), "=",
                            input.getAttribute("value"), "(",
                            input.getAttribute("type"), ")");
            }
        }).then(null, (error) => {
            console.exception(error);
            this._on_logout();
        });

    },
    
    /**
     * Called when the account has been logged out
     */
    _on_logout: function() {
        
    },
    
    /**
     * The domain of this account
     */
    get domain() this.username.replace(/^.*@/, ""),
    
    /**
     * The user name for this account
     */
    get user() this.username.replace(/@.*?$/, ""),
    
    /**
     * Whether this account is o Google Apps for Domain account
     */
    get isHosted() ["gmail.com", "googlemail.com"].indexOf(this.domain) >= 0,
    
    /**
     * The URL to use for logging in
     */
    get _loginURL() this.isHosted ?
        URL("https://www.google.com/a/" + this.domain + "/LoginAction2") :
        URL("https://accounts.google.com/ServiceLoginAuth"),
    
    /**
     * The URL to use for checking mail
     */
    get _checkURL() this.isHosted ?
        URL("https://mail.google.com/a/" + this.domain + "/") :
        URL("https://mail.google.com/mail/"),
});