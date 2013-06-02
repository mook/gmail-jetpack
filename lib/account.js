"use strict";

const self = require("self");
const { storage } = require("sdk/simple-storage");
const passwords = require("sdk/passwords");
const { Class } = require('sdk/core/heritage');
const { URL } = require("sdk/url");
const { RequestPromise } = require("./request");
const { CookieJar } = require("./cookiejar");
const { defer, reject } = require("sdk/core/promise");

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
            onCommand: () => this.check(),
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
            this.check();
        }
    },

    /**
     * Fetch a URL, and does an automatic login if it seems necessary
     * @param opts {Object} Same as ./request::Request
     * @yields {Document}
     */
    loginPromise: function(opts) {
        let isLoginURL = (url) =>
            (url.origin == this._loginURL.origin && url.pathname == this._loginURL.pathname);

        if (isLoginURL(opts.url)) {
            throw "Can't use loginPromise with the login URL!";
        }
        return RequestPromise(opts)
        .then((loginRequestDoc) => {
            let loginRequestURL = new URL(loginRequestDoc.documentURI);
            if (!isLoginURL(loginRequestURL)) {
                console.log("Got", loginRequestURL, "is not login url",
                            this._loginURL,
                            "origin:", loginRequestURL.origin, "/", this._loginURL.origin,
                            "path:", loginRequestURL.path, "/", this._loginURL.path,
                            JSON.stringify(loginRequestURL));
                return loginRequestDoc; // Done logins, probably
            }

            let deferred = defer();

            require("sdk/passwords").search({
                username: this.username,
                url: "https://accounts.google.com",
                onComplete: deferred.resolve,
                onError: deferred.reject,
            });

            deferred.promise.then((logins) => {
                console.log("Have password for", this.username);
                return logins[0].password;
            }).then((password) => {
                let form = loginRequestDoc.querySelector('form[action][method]');
                let data = {};
                for (let input of form.querySelectorAll('input')) {
                    let name = input.getAttribute("name");
                    let type = input.getAttribute("type");
                    let value = input.value;
                    if (name == "Email" || type == "email") {
                        value = this.isHosted ? this.user : this.username;
                    } else if (type == "password") {
                        value = password;
                    }
                    data[name] = value;
                }
                delete data.PersistentCookie;
                console.log("Sending login request...");
                return RequestPromise({
                    url: new URL(form.getAttribute("action"), loginRequestURL),
                    method: form.getAttribute("method") || "POST",
                    cookiejar: this.cookiejar,
                    data: data,
                    referrer: loginRequestURL.toString(),
                });
            }).then((doc) => {
                console.log("Possibly logged in...");
                let cookies = this.cookiejar.get(this._loginURL);
                if (isLoginURL(doc.documentURI)) {
                    throw "Login loop";
                }
                return doc;
            }).then((doc) => {
                this.button.image = self.data.url("images/online.png");
                return doc;
            }).then(null, (error) => {
                console.exception(error);
                this._on_logout();
                reject(error);
            });
            return deferred.promise;
        });
    },
    
    check: function() {
        this.loginPromise({
            url: this._checkURL,
            method: "GET",
            cookiejar: this.cookiejar,
        }).then((doc) => {
            console.log("Got document:", doc);
        }).then(null, (error) => {
            console.exception(error);
            this._on_logout();
        });
    },
    
    /**
     * Called when the account has been logged out
     */
    _on_logout: function() {
        this.button.image = self.data.url("images/offline.png");
        // Clear cookies
        this.cookiejar = new CookieJar();
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
    get isHosted() ["gmail.com", "googlemail.com"].indexOf(this.domain) < 0,
    
    /**
     * The URL to use for logging in
     */
    get _loginURL() this.isHosted ?
        URL("https://www.google.com/a/" + this.domain + "/ServiceLogin") :
        URL("https://accounts.google.com/ServiceLoginAuth"),
    
    /**
     * The URL to use for checking mail
     */
    get _checkURL() this.isHosted ?
        URL("https://mail.google.com/a/" + this.domain + "/") :
        URL("https://mail.google.com/mail/"),
});