var Sequelize = require("sequelize");
var diff = require("deep-diff").diff;
var jsdiff = require("diff");
var _ = require('lodash');
var iouuid = require("innodb-optimized-uuid");

module.exports = function(sequelize, options){
   if(!options){
      options = {};
   }
   if(!options.exclude){
      options.exclude = [
         "id", "createdAt", "updatedAt"
      ];
   }
   if(!options.revisionAttribute){
      options.revisionAttribute = "revision";
   }
   if(!options.revisionModel){
      options.revisionModel = "revisions";
   }
   if(!options.revisionChangeModel){
      options.revisionChangeModel = "revisionChanges";
   }
   if(options.UUID === undefined){
      options.UUID = false;
   }
   var log = options.log || console.log;

   // Extend model prototype with "isRevisionable" function
   // Call model.isRevisionable() to enable revisions for model
   _.extend(sequelize.Model.prototype, {
      enableRevisions: function () {
         log("Enable revisions on " + this.name);
         this.attributes["revision"] = {
            type: Sequelize.INTEGER,
            defaultValue: 0
         }
         this.revisionable = true;
         this.refreshAttributes();

         this.addHook("afterCreate", after);
         this.addHook("afterUpdate", after);
         this.addHook("afterDestroy", after);
         //this.addHook("afterBulkDestroy", after);
         this.addHook("beforeCreate", before);
         this.addHook("beforeUpdate", before);
         //this.addHook("beforeBulkDestroy", before);
         this.addHook("beforeDestroy", before);
         return this;
      }
   });

   // Before create/update augment revision
   var before = function(instance, opt){
      console.log("before", opt);
      var previousVersion = (opt.type === 'BULKDELETE') ? {deletedAt: null} : instance._previousDataValues;
      var currentVersion = (opt.type === 'BULKDELETE') ? {deletedAt: new Date()} : instance.dataValues;

      // Disallow change of revision
      instance.set(options.revisionAttribute, instance._previousDataValues[options.revisionAttribute]);

      // Get diffs
      var diffs = getDifferences(previousVersion, currentVersion, options.exclude);
      console.log("before:diffs", diffs);
      if((diffs && diffs.length > 0) || opt.type === 'BULKDELETE' ){
         instance.set(options.revisionAttribute, (instance.get(options.revisionAttribute) || 0) + 1);
         if(!instance.context){
            instance.context = {};
         }
         instance.context.diffs = diffs;
      }
   };

   // After create/update store diffs
   var after = function(instance, opt){
      console.log("after", opt);
      console.log("diffs", instance.context.diffs);
      console.log("diffs", instance.context.diffs.length);
      if(instance.context && instance.context.diffs && instance.context.diffs.length > 0){
         var Revisions = sequelize.model(options.revisionModel);
         var RevisionChanges = sequelize.model(options.revisionChangeModel);
         var diffs = instance.context.diffs;
         var previousVersion = instance._previousDataValues;
         var currentVersion = instance.dataValues;
         var name = (typeof instance.$modelOptions.name === "object") ? instance.$modelOptions.name.plural : instance.$modelOptions.name;
         var user = opt.user;
         if(!user && instance.context && instance.context.user){
            user = instance.context.user;
         }

         // Build revision
          var revision = Revisions.build({
            id: iouuid.generate().toLowerCase(),
            model: name,
            documentId: instance.get("id"),
            revision: instance.get(options.revisionAttribute),
            // Hacky, but necessary to get immutable current representation
            document: JSON.stringify(currentVersion),
            // Get user from instance.context, hacky workaround, any better idea?
            userId: options.userModel && user ? user.id : null
          });
         // Save revision
         revision.save().then(
           function(revision){
            // Loop diffs and create a revision-diff for each
            diffs.forEach(
              function(difference){
               var o = convertToString(difference.item ? difference.item.lhs : difference.lhs);
               var n = convertToString(difference.item ? difference.item.rhs : difference.rhs);
               var d = RevisionChanges.build({
                  id: iouuid.generate().toLowerCase(),
                  path: difference.path[0],
                  document: JSON.stringify(difference),
                  revisionId: revision.id,
                  diff: o || n ? JSON.stringify(jsdiff.diffChars(o, n)) : ''
               });
               d.save().then(
                function(d){
                  // Add diff to revision
                  revision.addChange(d);
                  return null;
                }
               ).catch(log);
              }
            );
          }
         ).catch(
           log
         );
      }
   };

   return {
      // Return defineModels()
      defineModels: function(){
         var attributes = {
           "id": {
              type: Sequelize.BLOB,
              primaryKey: true,
              get: function()  {
                if (this.getDataValue('id')) {
                  return this.getDataValue('id').toString('hex');
                } else {
                  return null;
                }
              },
              set: function(val) {
                this.setDataValue('id', new Buffer(val, "hex"));
              }
            },
            "model": {
               type: Sequelize.TEXT,
               allowNull: false
            },
            "documentId": {
                type: Sequelize.BLOB,
                primaryKey: true,
                get: function()  {
                  return this.getDataValue('documentId').toString('hex');
                },
                set: function(val) {
                  this.setDataValue('documentId', new Buffer(val, "hex"));
                }
            },
            "revision": {
               type: Sequelize.INTEGER,
               allowNull: false
            },
            "document": {
               type: Sequelize.TEXT,
               allowNull: false
            },
            "createdAt": Sequelize.DATE,
            "updatedAt": Sequelize.DATE,
            "deletedAt": Sequelize.DATE
         };
         if(options.UUID){
            attributes.id = {
               primaryKey: true,
               type: Sequelize.UUID,
               defaultValue: Sequelize.UUIDV4
            };
            attributes.documentId.type = Sequelize.UUID;
         }
         // Revision model
         var Revisions = sequelize.define(options.revisionModel, attributes);

         attributes = {
            "id": {
              type: Sequelize.BLOB,
              primaryKey: true,
              get: function()  {
                if (this.getDataValue('id')) {
                  return this.getDataValue('id').toString('hex');
                } else {
                  return null;
                }
              },
              set: function(val) {
                this.setDataValue('id', new Buffer(val, "hex"));
              }
            },
            "path": {
               type: Sequelize.TEXT,
               allowNull: false
            },
            "document": {
               type: Sequelize.TEXT,
               allowNull: false
            },
            "diff": {
               type: Sequelize.TEXT,
               allowNull: false
            },
            "revisionId": {
              type: Sequelize.BLOB,
              primaryKey: true,
              get: function()  {
                return this.getDataValue('revisionId').toString('hex');
              },
              set: function(val) {
                this.setDataValue('revisionId', new Buffer(val, "hex"));
              }
            },
            "createdAt": Sequelize.DATE,
            "updatedAt": Sequelize.DATE,
            "deletedAt": Sequelize.DATE
         };
         if(options.UUID){
            attributes.id = {
               primaryKey: true,
               type: Sequelize.UUID,
               defaultValue: Sequelize.UUIDV4
            };
         }

         // RevisionChange model
         var RevisionChanges = sequelize.define(options.revisionChangeModel, attributes);
         // Set associations
         Revisions.hasMany(RevisionChanges, {
            foreignKey: "revisionId",
            constraints: true,
            as: "changes"
         });
         // Associate with user if necessary
         if (options.userModel) {
            Revisions.belongsTo(sequelize.model(options.userModel), {
               foreignKey: "userId",
               constraints: true,
               as: "user"
            });
         }
         return Revisions;
      }
   }
}

// Helper: Get differences between objects
var getDifferences = function(current, next, exclude){
   var di = diff(current, next);
   var diffs = di ? di.map(function(i){
      var str = JSON.stringify(i).replace("\"__data\",", "");
      return JSON.parse(str);
   }).filter(function(i){
      return i.path.join(",").indexOf("_") === -1;
   }).filter(function(i){
      return exclude.every(function(x){return i.path.indexOf(x) === -1; });
   }) : [];
   if(diffs.length > 0){
      return diffs;
   }
   else{
      return null;
   }
}

// Helper: Convert value to some senseful string representation for storage
var convertToString = function(val){
   if(typeof val === "undefined" || val === null){
      return "";
   }
   else if(val === true){
      return "1";
   }
   else if(val === false){
      return "0";
   }
   else if(typeof val === "string"){
      return val;
   }
   else if(!isNaN(val)){
      return String(val) + "";
   }
   else if(typeof val === "object"){
      return JSON.stringify(val) + "";
   }
   else if(Array.isArray(val)){
      return JSON.stringify(val) + "";
   }
   return "";
};
