console.log('Cloud code connected');
const request = require('request');
const proxy = require('express-http-proxy');
const axios = require('axios');
const {config, SITE, ROLE_ADMIN, ROLE_EDITOR, promisifyW, getAllObjects} = require('./common');

const {getPayPlan} = require('./payment');


const checkRights = (user, obj) => {
  const acl = obj.getACL();
  if (!acl)
    return true;

  const read = acl.getReadAccess(user.id);
  const write = acl.getWriteAccess(user.id);

  const pRead = acl.getPublicReadAccess();
  const pWrite = acl.getPublicWriteAccess();

  return read && write || pRead && pWrite;
};


const getTableData = async (table) => {
  const endpoint = '/schemas/' + table;

  try {
    const response = await Parse.Cloud.httpRequest({
      url: config.serverURL + endpoint,
      method: 'GET',
      mode: 'cors',
      cache: 'no-cache',
      headers: {
        'Content-Type': 'application/json',
        'X-Parse-Application-Id': config.appId,
        'X-Parse-Master-Key': config.masterKey
      }
    });

    if (response.status == 200)
      return response.data;

  } catch (e) {}

  return null;
};

const setTableData = async (table, data, method = 'POST') => {
  const endpoint = '/schemas/' + table;

  const response = await Parse.Cloud.httpRequest({
    url: config.serverURL + endpoint,
    method,
    mode: 'cors',
    cache: 'no-cache',
    headers: {
      'Content-Type': 'application/json',
      'X-Parse-Application-Id': config.appId,
      'X-Parse-Master-Key': config.masterKey
    },
    body: JSON.stringify(data)
  });

  if (response.status != 200)
    throw response.status;
};

const deleteTable = async (table) => {
  const endpoint = '/schemas/' + table;

  const response = await Parse.Cloud.httpRequest({
    url: config.serverURL + endpoint,
    method: 'DELETE',
    mode: 'cors',
    cache: 'no-cache',
    headers: {
      'Content-Type': 'application/json',
      'X-Parse-Application-Id': config.appId,
      'X-Parse-Master-Key': config.masterKey
    }
  });

  if (response.status != 200)
    throw response.status;
};


const deleteContentItem = async (user, tableName, itemId) => {
  const item = await new Parse.Query(tableName)
    .get(itemId, {useMasterKey: true});

  if (!checkRights(user, item))
    throw "Access denied!";


  //removing MediaItem's belonging to content item
  const tableData = await getTableData(tableName);

  for (let field in tableData.fields) {
    const val = tableData.fields[field];
    if (val.type == 'Pointer' && val.targetClass == 'MediaItem') {
      const media = item.get(field);
      //!! uncontrolled async operation
      if (media)
        media.destroy({useMasterKey: true});
    }
  }


  //seeking draft version of content item
  const itemDraft = await new Parse.Query(tableName)
    .equalTo('t__owner', item)
    .first({useMasterKey: true});

  if (itemDraft) {
    if (!checkRights(user, itemDraft))
      throw "Access denied!";

    for (let field in tableData.fields) {
      const val = tableData.fields[field];
      if (val.type == 'Pointer' && val.targetClass == 'MediaItem') {
        const media = itemDraft.get(field);
        //!! uncontrolled async operation
        if (media)
          media.destroy({useMasterKey: true});
      }
    }

    await itemDraft.destroy({useMasterKey: true});
  }

  await item.destroy({useMasterKey: true});
};

const deleteModel = async (user, model, deleteRef = true, deleteModel = true) => {
  if (!checkRights(user, model))
    throw "Access denied!";


  //removing model fields
  let fields = await getAllObjects(
    new Parse.Query('ModelField')
      .equalTo('model', model)
  );

  let promises = [];
  for (let field of fields) {
    if (checkRights(user, field))
      promises.push(promisifyW(field.destroy({useMasterKey: true})));
  }
  await Promise.all(promises);


  //removing content items of model
  const tableName = model.get('tableName');
  const items = await getAllObjects(new Parse.Query(tableName));
  promises = [];
  for (let item of items) {
    promises.push(promisifyW(deleteContentItem(user, tableName, item.id)));
  }
  await Promise.all(promises);

  try {
    await deleteTable(tableName);
  } catch (e) {}


  //removing reference validation to model
  if (deleteRef) {
    const models = await getAllObjects(
      new Parse.Query('Model')
        .equalTo('site', model.get('site'))
    );
    fields = await getAllObjects(
      new Parse.Query('ModelField')
        .containedIn('model', models)
        .notEqualTo('model', model)
        .equalTo('type', 'Reference')
    );

    const promises = [];
    for (let field of fields) {
      const validations = field.get('validations');
      if (!validations || !validations.models || !validations.models.active || !validations.models.modelsList)
        continue;

      const i = validations.models.modelsList.indexOf(model.get('nameId'));
      if (i == -1)
        continue;

      validations.models.modelsList.splice(i, 1);
      field.set('validations', validations);
      promises.push(promisifyW(field.save(null, {useMasterKey: true})));
    }
    await Promise.all(promises);
  }


  //remove model
  if (deleteModel)
    await model.destroy({useMasterKey: true});
};


Parse.Cloud.define("deleteContentItem", async (request) => {
  if (!request.user)
    throw 'Must be signed in to call this Cloud Function.';

  const {tableName, itemId} = request.params;
  if (!tableName || !itemId)
    throw 'There is no tableName or itemId params!';

  try {
    await deleteContentItem(request.user, tableName, itemId);
    return "Successfully deleted content item.";
  } catch (error) {
    throw `Could not delete content item: ${error}`;
  }
});

Parse.Cloud.beforeDelete(`Model`, async request => {
  if (request.master)
    return;

  try {
    return await deleteModel(request.user, request.object, true, false);
  } catch (error) {
    throw `Could not delete model: ${JSON.stringify(error, null, 2)}`;
  }
});

Parse.Cloud.beforeDelete(`Site`, async request => {
  if (request.master)
    return;

  const site = request.object;

  if (!checkRights(request.user, site))
    throw "Access denied!";

  //removing site's models
  const models = await getAllObjects(
    new Parse.Query('Model')
      .equalTo('site', site));

  let promises = [];
  for (let model of models)
    promises.push(promisifyW(
      deleteModel(request.user, model, false)
    ));
  await Promise.all(promises);


  //removing site's collaborations
  const collabs = await getAllObjects(
    new Parse.Query('Collaboration')
      .equalTo('site', site));

  promises = [];
  for (let collab of collabs)
    promises.push(promisifyW(
      collab.destroy({useMasterKey: true})
    ));
  await Promise.all(promises);
});


const onCollaborationModify = async (collab, deleting = false) => {
  const site = collab.get('site');
  const user = collab.get('user');
  const role = collab.get('role');

  if (!user)
    return;

  await site.fetch({useMasterKey: true});

  //ACL for collaborations
  const owner = site.get('owner');
  let collabACL = collab.getACL();
  if (!collabACL)
    collabACL = new Parse.ACL(owner);

  //getting all site collabs
  const collabs = await getAllObjects(
    new Parse.Query('Collaboration')
      .equalTo('site', site)
      .notEqualTo('user', user));

  for (let tempCollab of collabs) {
    if (tempCollab.id == collab.id)
      continue;

    //set ACL for others collab
    let tempCollabACL = tempCollab.getACL();
    if (!tempCollabACL)
      tempCollabACL = new Parse.ACL(owner);

    tempCollabACL.setReadAccess(user, !deleting && role == ROLE_ADMIN);
    tempCollabACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);

    tempCollab.setACL(tempCollabACL);
    //!! uncontrolled async operation
    tempCollab.save(null, {useMasterKey: true});

    //set ACL for current collab
    if (!deleting) {
      const tempRole = tempCollab.get('role');
      const tempUser = tempCollab.get('user');

      if (!tempUser)
        continue;

      collabACL.setReadAccess(tempUser, tempRole == ROLE_ADMIN);
      collabACL.setWriteAccess(tempUser, tempRole == ROLE_ADMIN);
    }
  }

  collabACL.setReadAccess(user, true);
  collabACL.setWriteAccess(user, true);
  collab.setACL(collabACL);


  //ACL for site
  let siteACL = site.getACL();
  if (!siteACL)
    siteACL = new Parse.ACL(owner);

  siteACL.setReadAccess(user, !deleting);
  siteACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
  site.setACL(siteACL);
  //!! uncontrolled async operation
  site.save(null, {useMasterKey: true});


  //ACL for media items
  const mediaItems = await getAllObjects(
    new Parse.Query('MediaItem')
      .equalTo('site', site));

  for (let item of mediaItems) {
    let itemACL = item.getACL();
    if (!itemACL)
      itemACL = new Parse.ACL(owner);

    itemACL.setReadAccess(user, !deleting);
    itemACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
    item.setACL(itemACL);
    //!! uncontrolled async operation
    item.save(null, {useMasterKey: true});
  }


  //ACL for models and content items
  const models = await getAllObjects(
    new Parse.Query('Model')
      .equalTo('site', site));

  for (let model of models) {
    let modelACL = model.getACL();
    if (!modelACL)
      modelACL = new Parse.ACL(owner);

    modelACL.setReadAccess(user, !deleting);
    modelACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
    model.setACL(modelACL);
    //!! uncontrolled async operation
    model.save(null, {useMasterKey: true});

    const tableName = model.get('tableName');
    //!! uncontrolled async operation
    getTableData(tableName)
      .then(response => {
        let CLP = response ? response.classLevelPermissions : null;
        if (!CLP)
          CLP = {
            'get': {},
            'find': {},
            'create': {},
            'update': {},
            'delete': {},
            'addField': {}
          };

        if (!deleting) {
          CLP['get'][user.id] = true;
          CLP['find'][user.id] = true;
        } else {
          if (CLP['get'].hasOwnProperty(user.id))
            delete CLP['get'][user.id];
          if (CLP['find'].hasOwnProperty(user.id))
            delete CLP['find'][user.id];
        }

        if (!deleting && (role == ROLE_ADMIN || role == ROLE_EDITOR)) {
          CLP['create'][user.id] = true;
          CLP['update'][user.id] = true;
          CLP['delete'][user.id] = true;
        } else {
          if (CLP['create'].hasOwnProperty(user.id))
            delete CLP['create'][user.id];
          if (CLP['update'].hasOwnProperty(user.id))
            delete CLP['update'][user.id];
          if (CLP['delete'].hasOwnProperty(user.id))
            delete CLP['delete'][user.id];
        }

        if (!deleting && role == ROLE_ADMIN)
          CLP['addField'][user.id] = true;
        else if (CLP['addField'].hasOwnProperty(user.id))
          delete CLP['addField'][user.id];

        //!! uncontrolled async operation
        const data = {"classLevelPermissions": CLP};
        setTableData(tableName, data)
          .catch(() => setTableData(tableName, data, 'PUT'));
      });
  }


  //ACL for fields
  const fields = await getAllObjects(
    new Parse.Query('ModelField')
      .containedIn('model', models));

  for (let field of fields) {
    let fieldACL = field.getACL();
    if (!fieldACL)
      fieldACL = new Parse.ACL(owner);

    fieldACL.setReadAccess(user, !deleting);
    fieldACL.setWriteAccess(user, !deleting && role == ROLE_ADMIN);
    field.setACL(fieldACL);
    //!! uncontrolled async operation
    field.save(null, {useMasterKey: true});
  }
};


Parse.Cloud.beforeSave("Collaboration", async request => {
  if (request.master)
    return;

  const collab = request.object;
  if (!checkRights(request.user, collab))
    throw "Access denied!";

  return onCollaborationModify(collab);
});

Parse.Cloud.beforeDelete("Collaboration", async request => {
  if (request.master)
    return;

  const collab = request.object;
  if (!checkRights(request.user, collab))
    throw "Access denied!";

  return onCollaborationModify(collab, true);
});

Parse.Cloud.beforeSave(Parse.User, request => {
  const user = request.object;
  const email = user.get('email');
  if (user.get('username') != email)
    user.set('username', email);
});

Parse.Cloud.afterSave(Parse.User, async request => {
  const user = request.object;

  const collabs = await new Parse.Query('Collaboration')
    .equalTo('email', user.get('email'))
    .find({useMasterKey: true});

  const promises = [];

  for (let collab of collabs) {
    if (collab.get('user'))
      continue;

    collab.set('user', user);
    collab.set('email', '');

    promises.push(collab.save(null, {useMasterKey: true}));
    promises.push(promisifyW(onCollaborationModify(collab)));
  }

  await Promise.all(promises);
});

Parse.Cloud.beforeSave("Site", async request => {
  if (request.master)
    return;

  //updating an existing site
  if (request.object.id)
    return true;

  const user = request.user;
  if (!user)
    throw 'Must be signed in to save sites.';

  const payPlan = await getPayPlan(user);
  if (!payPlan)
    return true;

  const sitesLimit = payPlan.get('limitSites');
  if (!sitesLimit)
    return true;

  const sites = await new Parse.Query('Site')
    .equalTo('owner', user)
    .count({useMasterKey: true});

  if (sites >= sitesLimit)
    throw `The user has exhausted their sites' limit!`;

  return true;
});

Parse.Cloud.beforeSave(`Model`, async request => {
  if (request.master)
    return;

  const model = request.object;
  if (model.id)
    return;

  const site = model.get('site');
  await site.fetch({useMasterKey: true});

  //ACL for collaborations
  const owner = site.get('owner');
  const modelACL = new Parse.ACL(owner);

  const collabs = await getAllObjects(
    new Parse.Query('Collaboration')
      .equalTo('site', site));

  const admins = [owner.id];
  const writers = [owner.id];
  const all = [owner.id];

  for (let collab of collabs) {
    const user = collab.get('user');
    const role = collab.get('role');

    if (!user)
      continue;

    modelACL.setReadAccess(user, true);
    modelACL.setWriteAccess(user, role == ROLE_ADMIN);

    if (role == ROLE_ADMIN)
      admins.push(user.id);
    if (role == ROLE_ADMIN || role == ROLE_EDITOR)
      writers.push(user.id);
    all.push(user.id);
  }

  model.setACL(modelACL);

  //set CLP for content table
  const CLP = {
    'get': {},
    'find': {},
    'create': {},
    'update': {},
    'delete': {},
    'addField': {}
  };

  for (let user of all) {
    CLP['get'][user] = true;
    CLP['find'][user] = true;
  }
  for (let user of writers) {
    CLP['create'][user] = true;
    CLP['update'][user] = true;
    CLP['delete'][user] = true;
  }
  for (let user of admins) {
    CLP['addField'][user] = true;
  }

  const data = {"classLevelPermissions": CLP};
  await setTableData(model.get('tableName'), data);
});

Parse.Cloud.beforeSave(`ModelField`, async request => {
  if (request.master)
    return;

  const field = request.object;
  if (field.id)
    return;

  const model = field.get('model');
  await model.fetch({useMasterKey: true});

  const site = model.get('site');
  await site.fetch({useMasterKey: true});

  //ACL for collaborations
  const owner = site.get('owner');
  const fieldACL = new Parse.ACL(owner);

  const collabs = await getAllObjects(
    new Parse.Query('Collaboration')
      .equalTo('site', site));

  for (let collab of collabs) {
    const user = collab.get('user');
    const role = collab.get('role');

    if (!user)
      continue;

    fieldACL.setReadAccess(user, true);
    fieldACL.setWriteAccess(user, role == ROLE_ADMIN);
  }

  field.setACL(fieldACL);
});

Parse.Cloud.beforeSave(`MediaItem`, async request => {
  if (request.master)
    return;

  const item = request.object;
  if (item.id)
    return;

  const site = item.get('site');
  await site.fetch({useMasterKey: true});

  //ACL for collaborations
  const owner = site.get('owner');
  const itemACL = new Parse.ACL(owner);

  const collabs = await getAllObjects(
    new Parse.Query('Collaboration')
      .equalTo('site', site));

  for (let collab of collabs) {
    const user = collab.get('user');
    const role = collab.get('role');

    if (!user)
      continue;

    itemACL.setReadAccess(user, true);
    itemACL.setWriteAccess(user, role == ROLE_ADMIN);
  }

  item.setACL(itemACL);
});


Parse.Cloud.define("onContentModify", async request => {
  if (!request.user)
    throw 'Must be signed in to call this Cloud Function.';

  const {URL} = request.params;
  if (!URL)
    return 'Warning! There is no content hook!';

  const response = await Parse.Cloud.httpRequest({
    url: URL,
    method: 'GET'
  });

  if (response.status == 200)
    return response.data;
  else
    throw response.status;
});

Parse.Cloud.define("inviteUser", async request => {
  if (!request.user)
    throw 'Must be signed in to call this Cloud Function.';

  const {email, siteName} = request.params;
  if (!email || !siteName)
    throw 'Email or siteName is empty!';

  console.log(`Send invite to ${email} ${new Date()}`);

  const {AppCache} = require('parse-server/lib/cache');
  const emailAdapter = AppCache.get(config.appId)['userController']['adapter'];

  const emailSelf = request.user.get('email');
  const link = `${SITE}/sign?mode=register&email=${email}`;

  try {
    await emailAdapter.send({
      templateName: 'inviteEmail',
      recipient: email,
      variables: {siteName, emailSelf, link}
    });
    console.log(`Invite sent to ${email} ${new Date()}`);
    return "Invite email sent!";

  } catch (error) {
    console.error(`Got an error in inviteUser: ${error}`);
    throw error;
  }
});

Parse.Cloud.define("checkPassword", request => {
  if (!request.user)
    throw 'Must be signed in to call this Cloud Function.';

  const {password} = request.params;
  if (!password)
    throw 'There is no password param!';

  const username = request.user.get('username');

  return Parse.User.logIn(username, password);
});

// Get Site nameId to generate Model names
const getSiteNameId = async(parseServerSiteId) => {
  const siteQuery = new Parse.Query('Site');
  if (parseServerSiteId) siteQuery.equalTo('objectId', parseServerSiteId);
  const siteRecord = await siteQuery.first({useMasterKey: true});
  if (!siteRecord || !siteRecord.get('nameId')) return null;
  return siteRecord.get('nameId');
}

// As we are not sure where we use legacy siteId params.
// For new versions, we encourage you to use parseServerSiteId
Parse.Cloud.define("getSiteNameId", async (request) => {
  const { siteId, parseServerSiteId } = request.params;
  try {
    const siteNameId = await getSiteNameId(siteId || parseServerSiteId);
    
    return { status: 'success', siteNameId };
  } catch (error) {
    console.error('inside getSiteNameId', error);
    return { status: 'error', error };
  }
});

// Creates a Published object with the given data
// Creates a Draft version as well and assigns the owner (the above created published object)
const safeCreateForChisel = async (ModelName, newData) => {
  try {
    const tModelObject = await getModelObject(ModelName);

    // This sampleInstance is for getting ACL and t__color, probably won't be that necessary, though
    const sampleInstanceQuery = new Parse.Query(ModelName);
    const sampleInstance = await sampleInstanceQuery.first();

    const ModelModel = Parse.Object.extend(ModelName);
    const publishedObject = new ModelModel();

    // Set properties for both Published and Draft objects from the newData
    Object.keys(newData)
      .filter((key) => newData[key]) // Filter out any falsy values in newData
      .forEach((key) => {
        publishedObject.set(key, newData[key]);
      });

    // Set the status and model for both objects
    publishedObject.set('t__status', 'Published');
    publishedObject.set('t__model', tModelObject);


    // Apply sampleInstance properties to both objects, if available
    if (sampleInstance) {
      if (sampleInstance.get('t__color')) {
        publishedObject.set('t__color', sampleInstance.get('t__color'));
      }
      if (sampleInstance.get('ACL')) {
        publishedObject.set('ACL', sampleInstance.get('ACL'));
      }
    }

    // Save both objects
    await publishedObject.save();

    return [publishedObject];
  } catch (error) {
    console.error('Error in safeCreateForChisel', error);
    return { status: 'error', error };
  }
};



// Update both the Draft and Published versions with the given newData
const safeUpdateForChisel = async (ModelName, publishedObject, newData) => {
  try {
    // Update the Published object with newData
    Object.keys(newData).forEach((key) => publishedObject.set(key, newData[key]));
    await publishedObject.save();

    // Check if there is a Draft object associated with the Published object
    const draftObjectQuery = new Parse.Query(ModelName);
    draftObjectQuery.equalTo('t__owner', publishedObject);
    const draftObject = await draftObjectQuery.first();

    // If a Draft object exists, update it with newData as well
    if (draftObject) {
      Object.keys(newData).forEach((key) => draftObject.set(key, newData[key]));
      await draftObject.save();
    }
  } catch (error) {
    console.error('Error in safeUpdateForChisel', error);
  }
};

const getModelObject = async(modelName) => {
  try {
    const query = new Parse.Query('Model');
    query.equalTo('tableName', modelName);
    const object = await query.first({useMasterKey: true});
    return object;
  } catch(error) {
    console.log('Error in getModelObject', modelName)
  }
  return null;
}

const createMediaItemInstanceWithId = async(objectId) => {
  const MediaItemModel = Parse.Object.extend('MediaItem');
  const newMediaItemObject = new MediaItemModel();
  newMediaItemObject.id = objectId;
  return newMediaItemObject;
}
const createMediaItemFromFile = async(fileRecord) => {
  const siteQuery = new Parse.Query('Site');
  const siteObject = await siteQuery.first({ useMasterKey: true });
  const MediaItemModel = Parse.Object.extend('MediaItem');
  const newMediaItemObject = new MediaItemModel();
  newMediaItemObject.set('site', siteObject);
  newMediaItemObject.set('assigned', true);
  newMediaItemObject.set('type', fileRecord._type);
  newMediaItemObject.set('size', fileRecord._size);
  newMediaItemObject.set('file', fileRecord);
  newMediaItemObject.set('name', fileRecord._name);
  await newMediaItemObject.save();
  return newMediaItemObject;
}




function getDeveloperFromAppObject(appObject) {
  let developer = null;
  const developerObject = appObject.get('Developer');

  if (developerObject && developerObject.length > 0) {
    developer = {
      id: developerObject[0].id,
      name: developerObject[0].get('Name'),
      verified: developerObject[0].get('Verified') || false,
      company: developerObject[0].get('Company') || '',
      country: developerObject[0].get('Country') || '',
      website: developerObject[0].get('Website') || '',
      email: developerObject[0].get('Email') || '',
      isActive: developerObject[0].get('IsActive') || false,
    }
  }
  return developer;
}

function getAppContentFromAppObject(appObject) {
  let developerContent = null;
  const developerContentObject = appObject.get('Content');
  if (developerContentObject && developerContentObject.length > 0) {
    let icon = null;
    if (developerContentObject[0].get('Icon')) {
      icon = developerContentObject[0].get('Icon').get('file');
    }
    let screenshots = [], screenshotObjects = [];
    if (developerContentObject[0].get('Screenshots') && developerContentObject[0].get('Screenshots').length > 0) {
      screenshotObjects = developerContentObject[0].get('Screenshots')
        .filter(screen => screen.get('file'))
        .map(screen => screen.get('file'));
      screenshots = developerContentObject[0].get('Screenshots')
        .filter(screen => screen.get('file'))
        .map(screen => screen.get('file')._url);
    }
    let categories = [];
    if (developerContentObject[0].get('Categories') && developerContentObject[0].get('Categories').length > 0) {
      categories = developerContentObject[0].get('Categories').map(category => ({
        name: category.get('Name'),
        slug: category.get('Slug'),
        id: category.id
      }))
    }
    let keyImage = null;
    if (developerContentObject[0].get('Key_Image') && developerContentObject[0].get('Key_Image').get('file'))
      keyImage = developerContentObject[0].get('Key_Image').get('file')._url;
    developerContent = {
      id: developerContentObject[0].id,
      shortName: developerContentObject[0].get('Short_Name'),
      keyImage,
      description: developerContentObject[0].get('Description') || '',
      termsURL: developerContentObject[0].get('Terms_URL') || '',
      privacyURL: developerContentObject[0].get('Privacy_URL') || '',
      featured: developerContentObject[0].get('Featured_') || false,
      listing: developerContentObject[0].get('Listing') || [],
      filters: developerContentObject[0].get('Filters') || [],
      categories,
      icon,
      screenshots,
      screenshotObjects
    }
  }
  return developerContent;
}


function getAppDataFromAppObject(appObject) {
  let developerData = null;
  const developerDataObject = appObject.get('Data');

  if (developerDataObject && developerDataObject.length > 0) {    
    let dashboardSettings = null;

    if (developerDataObject[0].get('Dashboard_Setting') && developerDataObject[0].get('Dashboard_Setting').length > 0) {
      dashboardSettings = developerDataObject[0].get('Dashboard_Setting')[0];
    }

    developerData = {
      id: developerDataObject[0].id,
      dataName: developerDataObject[0].get('Data_Name'),
      installsCount: developerDataObject[0].get('Installs_Count'),
      status: developerDataObject[0].get('Status'),
      rating: developerDataObject[0].get('Rating'),
      isPaid: developerDataObject[0].get('Is_Paid_') || false,
      feeType: developerDataObject[0].get('Fee_Type') || null,
      feeAmount: developerDataObject[0].get('Fee_Amount') || null,
      capabilities: developerDataObject[0].get('Capabilities') || null,
      facilitatorMode: developerDataObject[0].get('Facilitator_Mode') || null,
      permissions: developerDataObject[0].get('Permissions') || [],
      sandboxPermissions: developerDataObject[0].get('Sandbox_Permissions') || [],
      dashboardSettings,
    }
  }
  return developerData;
}

// Get site info from app object / security
async function getSiteInfoFromAppObject(appObject) {
  try {
    const securityObject = appObject.get('Security');
    if (securityObject && securityObject[0] && securityObject[0].get('Forge_API_Key')) {
      const url = 'https://getforge.com/api/v2/settings/site_info?site_token=' + securityObject[0].get('Forge_API_Key');
      const result = await axios.get(url);
      return result.data ? result.data.message : null;
    }
    return null
  } catch(error) {
    console.error("inside getSiteInfoFromAppObject", error);
    // throw error;
    return null;
  }
}

function getSecurityFromAppObject(appObject) {
  try {
    let security = null;
    const securityObject = appObject.get('Security');
    if (securityObject && securityObject.length > 0) {
      const policy = securityObject[0].get('Policy');
      if (policy) {
        security = {
          id: policy[0].id,
          name: policy[0].get('Policy_Name'),
          EvalSafe_Pass_Max: policy[0].get('Eval_Safe_Pass_Max'),
          EvalSafe_Pass_Min: policy[0].get('EvalSafe_Pass_Min'),
          EvalSafe_Warning_Max: policy[0].get('EvalSafe_Warning_Max'),
          EvalSafe_Warning_Min: policy[0].get('EvalSafe_Warning_Min'),
          EvalSafe_Fail_Max: policy[0].get('EvalSafe_Fail_Max'),
          EvalSafe_Fail_Min: policy[0].get('EvalSafe_Fail_Min'),
          RequireSSL: policy[0].get('RequireSSL'),
          RequireForceSSL: policy[0].get('RequireForceSSL'),
          AllowExternalNetworkRequest: policy[0].get('AllowExternalNetworkRequest'),
          ExternalRequestAllowList: policy[0].get('ExternalRequestAllowList'),
          ExternalRequestsBlockList: policy[0].get('ExternalRequestsBlockList'),
          AllowInsecureNetworkURLs: policy[0].get('AllowInsecureNetworkURLs'),
          Bandwidth_Day_Usage_Limit: policy[0].get('Bandwidth_Day_Usage_Limit'),
          BandWidth_Week_Usage_Limit: policy[0].get('BandWidth_Week_Usage_Limit'),
          Forms_Allowed: policy[0].get('Forms_Allowed'),
          Forms_Limit: policy[0].get('Forms_Limit'),
          Allow_Collaborators: policy[0].get('Allow_Collaborators'),
          Collaborator_Limit: policy[0].get('Collaborator_Limit'),
          Media_Microphone_Allowed: policy[0].get('Media_Microphone_Allowed'),
          Media_Camera_Allowed: policy[0].get('Media_Camera_Allowed')
        };
      }
    }
    return security;
  } catch(error) {
    console.error("get security", error);
  }
}

// Used by both forge-client and forge-publisher
Parse.Cloud.define("getPluginsList", async (request) => {
  const { parseServerSiteId, filter } = request.params;
  try {
    const apps = await getPluginsList(parseServerSiteId, filter);
    
    return { status: 'success', apps };
  } catch (error) {
    console.error('Error in getPluginsList', error);
    return { status: 'error', error };
  }
});


// Example Request
// filter: {developer: ["p49LT4RS1u"], status: "Ready for Sale", category: 'developer'}
const getPluginsList = async(parseServerSiteId, filter) => {
  const { 
    developer: developerIds, 
    status, 
    category: categoryId,
    policy: policyId
  } = filter;
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;
    const DEVELOPER_APP_CONTENT_MODEL_NAME = `ct____${siteNameId}____Developer_App_Content`;
    const DEVELOPER_APP_DATA_MODEL_NAME = `ct____${siteNameId}____Developer_App_Data`;
    const DEVELOPER_APP_SECURITY_MODEL_NAME = `ct____${siteNameId}____Developer_App_Security`;
    const CATEGORY_MODEL_NAME = `ct____${siteNameId}____Category`;
    const DEVELOPER_MODEL_NAME = `ct____${siteNameId}____Developer`;
    const POLICY_MODEL_NAME = `ct____${siteNameId}____Policy`;

    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.include('Data');
    query.include(['Data.Dashboard_Setting']);
    query.include(['Data.Dashboard_Setting.SVG_Icon']);
    query.include(['Data.Capabilities']);
    query.include('Content');
    query.include('Content.Key_Image');
    query.include(['Content.Screenshots']);
    query.include(['Content.Catgories']);
    query.include('Security');   

    if (developerIds && developerIds.length > 0) {
      const developersQuery = new Parse.Query(DEVELOPER_MODEL_NAME);
      developersQuery.containedIn('objectId', developerIds);
      query.matchesQuery('Developer', developersQuery);
    }
    

    if (status) {
      const dataQuery = new Parse.Query(DEVELOPER_APP_DATA_MODEL_NAME);
      dataQuery.equalTo('Status', status);
      query.matchesQuery('Data', dataQuery);
    }

    if (categoryId) {
      const categoryQuery = new Parse.Query(CATEGORY_MODEL_NAME);
      categoryQuery.equalTo('t__status', 'Published');
      categoryQuery.equalTo('objectId', categoryId);
      const categoryObject = await categoryQuery.first({ useMasterKey: true });

      const contentQuery = new Parse.Query(DEVELOPER_APP_CONTENT_MODEL_NAME);
      contentQuery.equalTo('Categories', categoryObject);
      query.matchesQuery('Content', contentQuery);
    }

    if (policyId) {
      const policyQuery = new Parse.Query(POLICY_MODEL_NAME);
      policyQuery.equalTo('objectId', policyId);
      const policyObject = await policyQuery.first();

      const securityQuery = new Parse.Query(DEVELOPER_APP_SECURITY_MODEL_NAME);
      securityQuery.equalTo('Policy', policyObject);
      query.matchesQuery('Security', securityQuery);
    }


    
    const appObjects = await query.find({ useMasterKey: true });

    const lst = await Promise.all(
      appObjects.map(async(appObject) => {
        const developer = appObject.get('Developer') && appObject.get('Developer')[0] ? appObject.get('Developer')[0].id : null;
        const developerContent = getAppContentFromAppObject(appObject);
        const developerData = getAppDataFromAppObject(appObject);
        return {
          name: appObject.get('Name'),
          id: appObject.id,
          slug: appObject.get('Slug'),
          url: appObject.get('URL'),
          kind: appObject.get('Kind'),
          developer,
          developerContent,
          developerData,
        };
      })
    );
    return lst;

  } catch(error) {
    console.error('Error in getPluginsList function', error);
    throw error;
  }
}


// Legacy code, 
// Put back by Alfred on 2023/08/29
Parse.Cloud.define("getDeveloperAppByIds", async (request) => {
  const { siteId, parseServerSiteId, appIds } = request.params;
  try {
    const apps = await Promise.all(appIds.map(appId => getDeveloperAppById(siteId || parseServerSiteId, appId)));
    return { status: 'success', apps };
  } catch (error) {
    console.error('inside getDeveloperAppByIds', error);
    return { status: 'error', error };
  }
});

// Legacy code, 
// Put back by Alfred on 2023/08/29
Parse.Cloud.define("getDeveloperAppById", async (request) => {
  const { siteId, parseServerSiteId, appId } = request.params;
  try {
    const appDetail = await getDeveloperAppById(siteId || parseServerSiteId, appId);

    return { status: 'success', appDetail };
  } catch (error) {
    console.error('inside getDeveloperAppById', error);
    return { status: 'error', error };
  }
});


const getDeveloperAppById = async(parseServerSiteId, appId) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;

    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.equalTo('objectId', appId)
    query.include('Data');
    query.include('Content');
    query.include('Content.Key_Image');
    query.include(['Content.Screenshots']);
    query.include(['Content.Categories']);
    query.include('Developer');
    query.include('Security');
    query.include('Security.Policy');
    query.include(['Data.Capabilities']);
    query.include(['Data.Dashboard_Setting']);
    query.include(['Data.Dashboard_Setting.SVG_Icon']);
    query.include('Data.Facilitator_Mode');
    query.include('Data.Permissions');
    query.include('Data.Sandbox_Permissions');


    const appObject = await query.first({ useMasterKey: true });
    if (!appObject) return null;
    const developer = getDeveloperFromAppObject(appObject);
    const developerContent = getAppContentFromAppObject(appObject);
    const developerData = getAppDataFromAppObject(appObject);
    const developerSecurity = getSecurityFromAppObject(appObject);
    const siteInfo = await getSiteInfoFromAppObject(appObject);
    return {
      id: appObject.id,
      name: appObject.get('Name'),
      slug: appObject.get('Slug'),
      url: appObject.get('URL'),
      devURL: appObject.get('Dev_URL'),
      devMode: appObject.get('Dev_Mode'),
      developer,
      developerContent,
      developerData,
      developerSecurity,
      siteInfo
    }
  } catch(error) {
    console.error('inside getDeveloperAppById', error);
    throw error;
  }
}















// Used in forge-publisher site
Parse.Cloud.define("publishedAppsList", async (request) => {
  const { siteId, parseServerSiteId } = request.params;
  try {
    const apps = await getPluginsList(siteId || parseServerSiteId, { status: 'Ready for Sale' });
    
    return { status: 'success', apps };
  } catch (error) {
    console.error('inside publishedAppsList', error);
    return { status: 'error', error };
  }
});

// Used in forge-publisher site
Parse.Cloud.define("featuredAppsList", async (request) => {
  const { parseServerSiteId, siteId } = request.params;
  try {
    const featuredApps = await getFeaturedAppsList(siteId || parseServerSiteId);
    
    return { status: 'success', apps: featuredApps };
  } catch (error) {
    console.error('inside featuredAppsList', error);
    return { status: 'error', error };
  }
});

const getFeaturedAppsList = async(parseServerSiteId) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;
    const DEVELOPER_APP_DATA_MODEL_NAME = `ct____${siteNameId}____Developer_App_Data`;
    const DEVELOPER_APP_CONTENT_MODEL_NAME = `ct____${siteNameId}____Developer_App_Content`;

    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.include('Data');
    query.include('Content');
    query.include('Content.Key_Image');
    query.include(['Content.Screenshots']);
    query.include('Developer');
    query.include('Security');
    query.include(['Data.Dashboard_Setting']);
    query.include('Data.Facilitator_Mode');
    query.include('Data.Permissions');
    query.include('Data.Sandbox_Permissions');
    
    const readyForSaleQuery = new Parse.Query(DEVELOPER_APP_DATA_MODEL_NAME);
    readyForSaleQuery.equalTo('Status', 'Ready for Sale');
    query.matchesQuery('Data', readyForSaleQuery);

    const featuredQuery = new Parse.Query(DEVELOPER_APP_CONTENT_MODEL_NAME);
    featuredQuery.equalTo('Featured_', true);
    query.matchesQuery('Content', featuredQuery);

    const appObjects = await query.find({ useMasterKey: true });
    
    const list = await getAppListFromObjects(appObjects);
    return list;

  } catch(error) {
    console.error('inside getFeaturedAppsList', error);
    throw error;
  }
}

// Used in forge-publisher
// Special case where we use siteId instead of parseServerSiteId, not to break the legacy code
Parse.Cloud.define("appsMadeBy", async (request) => {
  const { siteId, parseServerSiteId, companyName } = request.params;
  try {
    const apps = await getAppsListMadeBy(siteId || parseServerSiteId, companyName);
    
    return { status: 'success', apps };
  } catch (error) {
    console.error('inside appsMadeBy', error);
    return { status: 'error', error };
  }
});

const getAppsListMadeBy = async(parseServerSiteId, companyName) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;
    const DEVELOPER_APP_DATA_MODEL_NAME = `ct____${siteNameId}____Developer_App_Data`;
    const DEVELOPER_MODEL_NAME = `ct____${siteNameId}____Developer`;

    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.include('Data');
    query.include('Content');
    query.include('Content.Key_Image');
    query.include(['Content.Screenshots']);
    query.include('Developer');
    query.include('Security');
    
    const readyForSaleQuery = new Parse.Query(DEVELOPER_APP_DATA_MODEL_NAME);
    readyForSaleQuery.equalTo('Status', 'Ready for Sale');
    query.matchesQuery('Data', readyForSaleQuery);

    const madeByQuery = new Parse.Query(DEVELOPER_MODEL_NAME);
    const companyQuery = new Parse.Query(DEVELOPER_MODEL_NAME);
    const nameQuery = new Parse.Query(DEVELOPER_MODEL_NAME);

    companyQuery.matches('Company', new RegExp(companyName, 'i')); // Case-insensitive LIKE operation on Company field
    nameQuery.matches('Name', new RegExp(companyName, 'i')); // Case-insensitive LIKE operation on Name field

    madeByQuery._orQuery([companyQuery, nameQuery]); // Combine the two queries using OR
    query.matchesQuery('Developer', madeByQuery);

    const appObjects = await query.find({ useMasterKey: true });
    
    const list = await getAppListFromObjects(appObjects);
    return list;

  } catch(error) {
    console.error('inside getAppsListMadeBy function', error);
    throw error;
  }
}

// Used in forge-publisher
Parse.Cloud.define("categoryAppsList", async (request) => {
  const { siteId, parseServerSiteId, categorySlug } = request.params;
  try {
    const apps = await getCategoryAppsList(siteId || parseServerSiteId, categorySlug);
    
    return { status: 'success', apps };
  } catch (error) {
    console.error('inside categoryAppsList', error);
    return { status: 'error', error };
  }
});

const getCategoryAppsList = async(parseServerSiteId, categorySlug) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;
    const DEVELOPER_APP_CONTENT_MODEL_NAME = `ct____${siteNameId}____Developer_App_Content`;
    const CATEGORY_MODEL_NAME = `ct____${siteNameId}____Category`;

    const categoryQuery = new Parse.Query(CATEGORY_MODEL_NAME);
    categoryQuery.equalTo('t__status', 'Published');
    categoryQuery.equalTo('Slug', categorySlug);
    const categoryObject = await categoryQuery.first({ useMasterKey: true });

    console.log("category object============", categoryObject);
    if (categoryObject) {
      const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
      query.equalTo('t__status', 'Published');
      query.include('Data');
      query.include('Content');
      query.include('Content.Icon');
      query.include('Content.Key_Image');
      query.include(['Content.Screenshots']);
      query.include('Developer');
      query.include('Security');

    
      const categoriesMatchQuery = new Parse.Query(DEVELOPER_APP_CONTENT_MODEL_NAME);
      categoriesMatchQuery.equalTo('Categories', categoryObject);
      query.matchesQuery('Content', categoriesMatchQuery);

      const appObjects = await query.find({ useMasterKey: true });
      
      const list = await getAppListFromObjects(appObjects);
      return list;
    }

    return [];

  } catch(error) {
    console.error('inside getCategoryAppsList', error);
    throw error;
  }
}

const getAppListFromObjects = async (appObjects) => {
  const list = await Promise.all(
    appObjects.map(async(appObject) => {
    
      const developer = getDeveloperFromAppObject(appObject);
      const developerContent = getAppContentFromAppObject(appObject);
      const developerData = getAppDataFromAppObject(appObject);
      // const siteInfo = await getSiteInfoFromAppObject(appObject);
      return {
        id: appObject.id,
        name: appObject.get('Name'),
        slug: appObject.get('Slug'),
        url: appObject.get('URL'),
        developer,
        developerContent,
        developerData,
        // siteInfo
      };
    })
  );
  return list.sort((a, b) => (a.name > b.name ? 1 : -1));
}

// Used in forge-publisher
// Special case where we use siteId instead of parseServerSiteId, not to break the legacy code
Parse.Cloud.define("searchApps", async (request) => {
  const { siteId, parseServerSiteId, keyword } = request.params;
  try {
    const apps = await searchApps(siteId || parseServerSiteId, keyword);
    
    return { status: 'success', apps };
  } catch (error) {
    console.error('inside searchApps', error);
    return { status: 'error', error };
  }
});

const searchApps = async(parseServerSiteId, keyword) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;

    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.matches('Name', keyword, 'i')
    query.include('Data');
    query.include('Content');
    query.include('Content.Key_Image');
    query.include(['Content.Screenshots']);
    query.include('Developer');
    query.include('Security');
    query.include('Security.Policy');
    
    const appObjects = await query.find({ useMasterKey: true });
    
    const list = await getAppListFromObjects(appObjects);
    return list;

  } catch(error) {
    console.error('inside searchApps', error);
    throw error;
  }
}


// Used in forge-publisher
Parse.Cloud.define("getAppDetail", async (request) => {
  const { parseServerSiteId, appSlug } = request.params;
  try {
    const appDetail = await getAppDetail(parseServerSiteId, appSlug);
    
    return { status: 'success', appDetail };
  } catch (error) {
    console.error('inside getAppDetail', error);
    return { status: 'error', error };
  }
});

const getAppDetail = async(parseServerSiteId, appSlug) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;

    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.equalTo('Slug', appSlug)
    query.include('Data');
    query.include('Content');
    query.include('Content.Icon');
    query.include('Content.Key_Image');
    query.include(['Content.Screenshots']);
    query.include(['Content.Categories']);
    query.include('Developer');
    query.include('Security');
    query.include('Security.Policy');
    
    const appObject = await query.first({ useMasterKey: true });
    if (!appObject) return null;
    const developer = getDeveloperFromAppObject(appObject);
    const developerContent = getAppContentFromAppObject(appObject);
    const developerData = getAppDataFromAppObject(appObject);
    const developerSecurity = getSecurityFromAppObject(appObject);
    const siteInfo = await getSiteInfoFromAppObject(appObject);
    return {
      id: appObject.id,
      name: appObject.get('Name'),
      slug: appObject.get('Slug'),
      url: appObject.get('URL'),
      developer,
      developerContent,
      developerData,
      developerSecurity,
      siteInfo
    }
  } catch(error) {
    console.error('inside getAppDetal', error);
    throw error;
  }
}

// Used in forge-publisher
Parse.Cloud.define("getPublisherSettings", async (request) => {
  const { parseServerSiteId } = request.params;
  try {
    const publisherSetting = await getPublisherSettings(parseServerSiteId);
    
    
    return { status: 'success', publisherSetting };
  } catch (error) {
    console.error('inside getPublisherSettings', error);
    return { status: 'error', error };
  }
});

const getPublisherSettings = async(parseServerSiteId) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const PUBLISHER_SETTING_MODEL_NAME = `ct____${siteNameId}____Publisher_Settings`;

    const query = new Parse.Query(PUBLISHER_SETTING_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.include('Logo');
    
    const publisherSettingObject = await query.first({ useMasterKey: true });
    if (!publisherSettingObject) return null;
    return {
      name: publisherSettingObject.get('Name'),
      logo: publisherSettingObject.get('Logo') ? publisherSettingObject.get('Logo').get('file')._url : '',
      primaryColor: publisherSettingObject.get('Primary_Colour'),
      secondaryColor: publisherSettingObject.get('Secondary_Colour'),
      appsListBanner: publisherSettingObject.get('Apps_List_Banner') ? publisherSettingObject.get('Logo').get('file')._url : ''
    };
  } catch(error) {
    console.error('inside getPublisherSettings function', error);
    throw error;
  }
}

const getMuralRedirectURI = (devMode) => {
  return devMode ? process.env.DEV_MURAL_REDIRECT_URI : process.env.MURAL_REDIRECT_URI;
}

// Used in forge-publisher, for auth
Parse.Cloud.define("getDeveloperFromUserId", async (request) => {
  const { siteId, parseServerSiteId, userId } = request.params;
  try {
    const developer = await getDeveloperFromUserId(siteId || parseServerSiteId, userId);
    const isMuralAdmin = await checkIfMuralAdmin(userId);
    return { status: 'success', developer, isMuralAdmin };
    // return { status: 'success', isMuralAdmin };
  } catch (error) {
    console.error('inside getDeveloperFromUserId', error);
    return { status: 'error', error };
  }
});

const getDeveloperFromUserId = async(parseServerSiteId, userId) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    // get site name Id and generate MODEL names based on that
    const DEVELOPER_MODEL_NAME = `ct____${siteNameId}____Developer`;
    const developerQuery = new Parse.Query(DEVELOPER_MODEL_NAME);
    const UserModel = Parse.Object.extend('User');
    const currentUser = new UserModel();
    currentUser.id = userId;
    developerQuery.equalTo('user', currentUser);
    developerQuery.equalTo('IsActive', true);
    const developerObject = await developerQuery.first();
    
    if (!developerObject) return null;
    
    return {
      id: developerObject.id,
      name: developerObject.get('Name'),
      verified: developerObject.get('Verified') || false,
      company: developerObject.get('Company') || '',
      country: developerObject.get('Country') || '',
      website: developerObject.get('Website') || '',
      email: developerObject.get('Email') || '',
      isActive: developerObject.get('IsActive') || false,
    };

  } catch(error) {
    console.error('inside getDeveloperFromUserId', error);
    throw error;
  }
}

const checkIfMuralAdmin = async(userId) => {
  try {
    const UserModel = Parse.Object.extend('User');
    const currentUser = new UserModel();
    currentUser.id = userId;

    const roleQuery = new Parse.Query(Parse.Role);
    roleQuery.equalTo('name', 'Mural Admins');
    const roleObject = await roleQuery.first();

    const adminRelation = new Parse.Relation(roleObject, 'users');
    const queryAdmins = adminRelation.query();
    const userObjects = await queryAdmins.find();
    for (const userObject of userObjects) {
      if (userObject.id.toString() === userId) return true;
    }
    return false;
  } catch(error) {
    console.error('inside checkIfMuralAdmin', error);
    throw error;
  }
}

// Mural Auth, used in mural auth and many other mural related plugins 
Parse.Cloud.define("authorize", async (request) => {
  const { params } = request;
  const authorizationUri = 'https://app.mural.co/api/public/v1/authorization/oauth2/';
  try {
    const query = new URLSearchParams();
    query.set('client_id', process.env.MURAL_CLIENT_ID);
    query.set('redirect_uri', getMuralRedirectURI(params.devMode));
    query.set('state', 123);
    query.set('response_type', 'code');
    const scopes = [
      "identity:read"
    ]
    query.set('scope', scopes.join(' '));
	  return { success: true, url: `${authorizationUri}?${query}`};
  } catch(error) {
    console.error('inside authorize', error);
    return { success: false, error };
  }
});

// Mural Auth, used in mural auth and many other mural related plugins
Parse.Cloud.define("token", async (request) => {
  try {
    const { params } = request;
    const redirect_uri = getMuralRedirectURI(params.devMode);
    const response = await axios.post('https://app.mural.co/api/public/v1/authorization/oauth2/token', 
      {
        client_id: process.env.MURAL_CLIENT_ID,
        client_secret: process.env.MURAL_CLIENT_SECRET,
        code: params.code,
        grant_type: 'authorization_code',
        redirect_uri
      });
    if (response.status!== 200) {
      throw 'token request failed';
    }
    const meResponse = await axios.get('https://app.mural.co/api/public/v1/users/me', {
      headers: {
        'Authorization': `Bearer ${response.data.access_token}`
      }
    });
    if (meResponse.status !== 200) {
      throw 'unauthorized for getting currentUser';
    }
    return {
      success: true,
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token,
      me: meResponse.data.value
    };
    
  } catch(error) {
    console.error("inside token", error);
    return { success: false, error };
  }
});

// Mural Auth, used in mural auth and many other mural related plugins
Parse.Cloud.define("refresh", async (request) => {
  try {
    const { params } = request;
    const { refreshToken } = params;
    const response = await axios.post('https://app.mural.co/api/public/v1/authorization/oauth2/refresh', 
      {
        client_id: process.env.MURAL_CLIENT_ID,
        client_secret: process.env.MURAL_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      });
    if (response.status!== 200) {
      throw 'token request failed';
    }
    return {
      success: true,
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token
    };
    
  } catch(error) {
    console.error("inside refresh", error);
    return { success: false, error };
  }
});

// Mural Auth, used in mural auth and many other mural related plugins
Parse.Cloud.define('linkWith', async(request) => {
  const { authData, email } = request.params;
  try {
    let user;
    // Check for existing user with email given from `token` request response
    const userQuery = new Parse.Query('User');
    userQuery.equalTo('email', email)
    user = await userQuery.first();
    const oldId = user ? user.id : null;

    if (!user) user = new Parse.User();
    await user.linkWith('mural', { authData }, { useMasterKey: true });
    
    // set username and email for the new user
    if (!oldId) {
      await user.save({ 
        'username': email, 
        'email': email
      }, 
      { useMasterKey: true });
    }
    return { status: 'success', user };
  } catch (error) {
    console.error('inside linkWith', error);
    return { status: 'error', error };
  }
})

// Mural Auth, used in mural auth
Parse.Cloud.define('activateDeveloper', async(request) => {
  try {
    const { parseServerSiteId, userId, developerId } = request.params;
    const developer = await activateDeveloper(parseServerSiteId, userId, developerId);
    return { status: 'success', developer };
  } catch (error) {
    console.error('inside activateDeveloper', error);
    return { status: 'error', error };
  }
});

const activateDeveloper = async(parseServerSiteId, userId, developerId) => {
  try {
    let i;
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    // Model related data preparation
    const DEVELOPER_MODEL_NAME = `ct____${siteNameId}____Developer`;
    const UserModel = Parse.Object.extend('User');
    const currentUser = new UserModel();
    currentUser.id = userId;

    // 
    const DeveloperModel = Parse.Object.extend(DEVELOPER_MODEL_NAME);
    const developerQuery = new Parse.Query(DEVELOPER_MODEL_NAME);
    developerQuery.equalTo('user', currentUser);
    const results = await developerQuery.find();
    for (i = 0; i < results.length; i++) {
      if (results[i].id !== developerId) {
        const updatedDeveloper = new DeveloperModel();
        updatedDeveloper.id = results[i].id;
        updatedDeveloper.set('IsActive', false);
        await updatedDeveloper.save();
      }
    }

    const currentDeveloperQuery = new Parse.Query(DEVELOPER_MODEL_NAME);
    currentDeveloperQuery.equalTo('objectId', developerId);
    const currentDeveloper = await currentDeveloperQuery.first();
    currentDeveloper.set('IsActive', true);
    await currentDeveloper.save();

    return {
      id: currentDeveloper.id,
      name: currentDeveloper.get('Name'),
      verified: currentDeveloper.get('Verified') || false,
      company: currentDeveloper.get('Company') || '',
      country: currentDeveloper.get('Country') || '',
      website: currentDeveloper.get('Website') || '',
      email: currentDeveloper.get('Email') || '',
      isActive: currentDeveloper.get('IsActive') || false,
    };

  } catch(error) {
    console.error("inside activateDeveloper function", error);
    throw error;
  }
}



// Called in forge-publisher 
Parse.Cloud.define("installDeveloperApp", async (request) => {
  try {
    const { parseServerSiteId, appId } = request.params;
    const result = await installDeveloperApp(parseServerSiteId, appId);
    return { status: 'success', result };
  } catch(error) {
    console.error('Error in installDeveloperApp', error);
  }
});

const installDeveloperApp = async(parseServerSiteId, appId) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;
    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.equalTo('objectId', appId.toString());
        
    const developerApp = await query.first();

    if (developerApp) {
      const installsCount = developerApp.get('Installs_Count') || 0;
      developerApp.set('Installs_Count', installsCount + 1);
      await developerApp.save();
    }
  } catch(error) {
    console.error('inside installDeveloperApp function', error);
    throw error;
  }
}

















// Called in forge-client, from Plugin Publish Flow
Parse.Cloud.define("buildApp", async (request) => {
  try {
    const result = await buildApp(request.params);
    return { status: 'success', ...result };
  } catch (error) {
    console.error('inside buildApp', error);
    return { status: 'error', error };
  }
});

// - Plugin Publish Flow Related
const buildApp = async (params) => {
  const { app, appContent, appData, developer, appSecurity, parseServerSiteId } = params;
  
  const siteNameId = await getSiteNameId(parseServerSiteId);
  const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;
  const DEVELOPER_APP_DATA_MODEL_NAME = `ct____${siteNameId}____Developer_App_Data`;
  const DEVELOPER_APP_SECURITY_MODEL_NAME = `ct____${siteNameId}____Developer_App_Security`;
  const DEVELOPER_MODEL_NAME = `ct____${siteNameId}____Developer`;

  // Find or Create based on the existing record. 
  // Main key for now here(to see if the existing record exists) is "app.slug"
  const appObject = await findOrCreateApp(DEVELOPER_APP_MODEL_NAME, app);
  let appContentObject, appDataObject, developerObject, appSecurityObject;
  if (appObject) {
    appContentObject = (appObject.get('Content') && appObject.get('Content')[0]) ? appObject.get('Content')[0] : null;
    appContentObject = await findOrCreateAppContent(siteNameId, appContentObject, appContent);
    appDataObject = (appObject.get('Data') && appObject.get('Data')[0]) ? appObject.get('Data')[0] : null;
    appDataObject = await findOrCreateAppData(DEVELOPER_APP_DATA_MODEL_NAME, appDataObject, appData, siteNameId);
    developerObject = await findOrCreateDeveloper(DEVELOPER_MODEL_NAME, developer);
    appSecurityObject = (appObject.get('Security') && appObject.get('Security')[0]) ? appObject.get('Security')[0] : null;
    appSecurityObject = await findOrCreateAppSecurity(DEVELOPER_APP_SECURITY_MODEL_NAME, appSecurityObject, appSecurity);
    
    // Update appObject with the sorted out Content, Data, Developer object
    await safeUpdateForChisel(DEVELOPER_APP_MODEL_NAME, appObject, {
      Content: appContentObject ? [appContentObject] : [], 
      Data: appDataObject ? [appDataObject] : [],
      Developer: developerObject ? [developerObject] : [],
      Security: appSecurityObject ? [appSecurityObject] : []
    });
  }
  return { appObject };
}
// - Plugin Publish Flow Related
const findOrCreateAppContent = async(siteNameId, appContentObject, appContent) => {
  const DEVELOPER_APP_CONTENT_MODEL_NAME = `ct____${siteNameId}____Developer_App_Content`;
  const iconObject = await handleIcon(appContent.Icon);
  console.log('==== find or create app content', iconObject);
  const [screenshotsObjects, keyImageObject] = await handleScreenshots(appContent.Screenshots, appContent.keyImageIndex);
  const newAppContent = { ...appContent, Screenshots: screenshotsObjects, Key_Image: keyImageObject, Icon: iconObject };
  if (appContent.Categories) {
    const categoriesObjects = await buildCategoryObjectsFromIds(siteNameId, appContent.Categories);
    newAppContent['Categories'] = categoriesObjects;
  }
  if (appContentObject) {
    await safeUpdateForChisel(DEVELOPER_APP_CONTENT_MODEL_NAME, appContentObject, newAppContent);
    return appContentObject;
  } else {
    const result = await safeCreateForChisel(DEVELOPER_APP_CONTENT_MODEL_NAME, newAppContent);
    return result && result.length > 0 ? result[0] : null;
  }
}

const buildCapabilitiesObjects = (id, siteNameId) => {
  const CAPABILITY_MODEL_NAME = `ct____${siteNameId}____Capability`;
  const CapabilityModel = Parse.Object.extend(CAPABILITY_MODEL_NAME);
  if (id) {
    const object = new CapabilityModel();
    object.id = id;
    return [object];
  }

  return [];
}

// - Plugin Publish Flow Related
const findOrCreateAppData = async(DEVELOPER_APP_DATA_MODEL_NAME, appDataObject, appData, siteNameId) => {
  const Capabilities = await buildCapabilitiesObjects(appData.Capabilities, siteNameId);
  const newAppData = { ...appData, Capabilities };

  if (appDataObject) {
    await safeUpdateForChisel(DEVELOPER_APP_DATA_MODEL_NAME, appDataObject, newAppData);
    return appDataObject
  } else {
    const result = await safeCreateForChisel(DEVELOPER_APP_DATA_MODEL_NAME, newAppData);
    return result && result.length > 0 ? result[0] : null;
  }
}
// - Plugin Publish Flow Related
const findOrCreateDeveloper = async(DEVELOPER_MODEL_NAME, developer) => {
  if (!developer || !developer.Email) return;
  const query = new Parse.Query(DEVELOPER_MODEL_NAME);
  query.equalTo('Email', developer.Email);
  query.equalTo('t__status', 'Published');
  let developerObject = await query.first();
  if (developerObject)
    await safeUpdateForChisel(DEVELOPER_MODEL_NAME, developerObject, developer);
  else {
    developerObject = await safeCreateForChisel(DEVELOPER_MODEL_NAME, developer);
    developerObject = developerObject ? developerObject[0] : null;
  }
  return developerObject;
}

// - Plugin Publish Flow Related
const findOrCreateAppSecurity = async(DEVELOPER_APP_SECURITY_MODEL_NAME, appSecurityObject, appSecurity) => {
  if (appSecurityObject) {
    await safeUpdateForChisel(DEVELOPER_APP_SECURITY_MODEL_NAME, appSecurityObject, appSecurity);
    return appSecurityObject;
  } else {
    const result = await safeCreateForChisel(DEVELOPER_APP_SECURITY_MODEL_NAME, appSecurity);
    return result && result.length > 0 ? result[0] : null;
  }
}

// Called in forge-client
// - Plugin Publish Flow Related
// - Handle icon upload, icon will be updated onto appContent, but not here
const handleIcon = async(icon) => {
  if (!icon) return null;
  let object = null;
  if (icon.id) {
    object = createMediaItemInstanceWithId(icon.id);
  } else {
    object = await createMediaItemFromFile(icon);
  }
  return object;
}


// - Plugin Publish Flow Related
const findOrCreateApp = async(DEVELOPER_APP_MODEL_NAME, app) => {
  const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
  query.equalTo('objectId', app.id);
  query.equalTo('t__status', 'Published');
  let appObject = await query.first();
  if (appObject) {
    await safeUpdateForChisel(DEVELOPER_APP_MODEL_NAME, appObject, app);
    appObject = await query.first();
  } else {
    const result = await safeCreateForChisel(DEVELOPER_APP_MODEL_NAME, app);
    appObject = result && result.length > 0 ? result[0] : null;
  }
  return appObject
}
// - Plugin Publish Flow Related
// - Handle mixed format of screenshot to a list of Screenshot objects
const handleScreenshots = async(screenshots, keyImageIndex) => {
  let keyImageScreenshot = null;
  if (!screenshots || screenshots.length < 1) return [[], null];
  const promises = screenshots.map(async (screenshot) => {
    let object;
    if (screenshot.id) {
      object = createMediaItemInstanceWithId(screenshot.id);
    } else {
      object = await createMediaItemFromFile(screenshot);
    }
    return object;
  });
  
  const objects = await Promise.all(promises);
  if (keyImageIndex !== -1 && keyImageIndex < objects.length)
    keyImageScreenshot = Parse.Object.extend("MediaItem").createWithoutData(objects[keyImageIndex].id);
  return [objects, keyImageScreenshot];
}


// - Plugin Publish Flow Related
// - Convert categories ids to Category Objects
const buildCategoryObjectsFromIds = async(parseServerSiteId, categoryIds) => {
  const siteNameId = await getSiteNameId(parseServerSiteId);
  const CategoryModel = Parse.Object.extend(`ct____${siteNameId}____Category`);
  return categoryIds.map(id => {
    const object = new CategoryModel();
    object.id = id;
    return object;
  })
}

















// Called in forge-client
Parse.Cloud.define("getPluginDetail", async (request) => {
  const { parseServerSiteId, appSlug } = request.params;
  try {
    const appDetail = await getPluginDetailBySlug(parseServerSiteId, appSlug);
    
    return { status: 'success', appDetail };
  } catch (error) {
    console.error('Error in getPluginDetail', error);
    return { status: 'error', error };
  }
});

const getPluginDetailBySlug = async(parseServerSiteId, appSlug) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;

    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.equalTo('Slug', appSlug)
    query.include('Data');
    query.include('Content');
    query.include('Content.Icon');
    query.include('Content.Key_Image');
    query.include(['Content.Screenshots']);
    query.include(['Content.Categories']);
    query.include('Developer');
    query.include('Security');
    query.include('Security.Policy');
    
    const appObject = await query.first({ useMasterKey: true });
    if (!appObject) return null;
    const appDetail = await getAppDetailFromObject(appObject);
    return appDetail;
  } catch(error) {
    console.error('Error in getPluginDetailBySlug function', error);
    throw error;
  }
}


// Called in forge-client, Plugin Publish Flow
// To check if we have developerApp linked with the current forge site, search By URL
Parse.Cloud.define("searchAppByURL", async (request) => {
  try {
    const { parseServerSiteId, url } = request.params;
    const appDetail = await searchAppByURL(parseServerSiteId, url);
    return { status: 'success', appDetail };
  } catch (error) {
    console.error('inside searchAppByURL', error);
    return { status: 'error', error };
  }
});


const searchAppByURL = async(parseServerSiteId, url) => {
  try {
    const siteNameId = await getSiteNameId(parseServerSiteId);
    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;
    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.contains('URL', url);
    query.equalTo('t__status', 'Published');
    query.include('Data');
    query.include('Content');
    query.include('Content.Icon');
    query.include('Content.Key_Image');
    query.include(['Content.Screenshots']);
    query.include(['Content.Catgories']);
    // query.include(['Data.Capabilities']);
    query.include('Developer');

    const appObject = await query.first({ useMasterKey: true });
    if (!appObject) return DEVELOPER_APP_MODEL_NAME;
    const appDetail = await getAppDetailFromObject(appObject);
    return appDetail;
  } catch(error) {
    console.error('inside searchAppByURL', error);
    return error;
  }
}

const getAppDetailFromObject = async(appObject) => {
  try {
    const developer = getDeveloperFromAppObject(appObject);
    const developerContent = getAppContentFromAppObject(appObject);
    const developerData = getAppDataFromAppObject(appObject);
    const developerSecurity = getSecurityFromAppObject(appObject);
    const siteInfo = await getSiteInfoFromAppObject(appObject);
    return {
      id: appObject.id,
      name: appObject.get('Name'),
      slug: appObject.get('Slug'),
      url: appObject.get('URL'),
      siteId: appObject.get('SiteId'),
      kind: appObject.get('Kind'),
      userId: appObject.get('UserId'),
      installParams: appObject.get('InstallParams'),
      developer,
      developerContent,
      developerData,
      developerSecurity,
      siteInfo,
    }
  } catch(error) {
    console.error('getAppDetailFromObject', error);
  }
}



// Called in forge-client, site apps and plugin publish flow
Parse.Cloud.define("findDeveloperByEmail", async (request) => {
  try {
    const { parseServerSiteId, email } = request.params;
    const developer = await findDeveloperByEmail(parseServerSiteId, email);
    return { status: 'success', developer };
  } catch (error) {
    console.error('inside findDeveloperByEmail', error);
    return { status: 'error', error };
  }
});


const findDeveloperByEmail = async(parseServerSiteId, email) => {
  try {
    const siteNameId = await getSiteNameId(parseServerSiteId);
    const DEVELOPER_MODEL_NAME = `ct____${siteNameId}____Developer`;
    const query = new Parse.Query(DEVELOPER_MODEL_NAME);
    query.equalTo('Email', email);
    query.equalTo('t__status', 'Published');
    let developerObject = await query.first();
    if (developerObject)
      return {
        id: developerObject.id,
        name: developerObject.get('Name'),
        verified: developerObject.get('Verified') || false,
        company: developerObject.get('Company') || '',
        country: developerObject.get('Country') || '',
        website: developerObject.get('Website') || '',
        email: developerObject.get('Email') || '',
        isActive: developerObject.get('IsActive') || false,
      }
  } catch(error) {
    console.error('Error in findDeveloperByEmail', error);
  }
  return null;
}


// Used in forge-client, plugin install params update drawer
Parse.Cloud.define("updateDeveloperAppData", async (request) => {
  try {
    const appData = await updateDeveloperAppData(request.params);

    return { status: 'success', appData };
  } catch (error) {
    console.error('inside updateDeveloperAppData', error);
    return { status: 'error', error };
  }
});

const updateDeveloperAppData = async(params) => {
  const { parseServerSiteId, appDataId, installParams, status } = params;
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }
    
    const DEVELOPER_APP_DATA_MODEL_NAME = `ct____${siteNameId}____Developer_App_Data`;
    const query = new Parse.Query(DEVELOPER_APP_DATA_MODEL_NAME);
    query.equalTo('objectId', appDataId);
    const appDataObject = await query.first();

    let newAppData = {
      Status: status
    };
    if (installParams) newAppData['InstallParams'] = installParams;

    await safeUpdateForChisel(DEVELOPER_APP_DATA_MODEL_NAME, appDataObject, newAppData);
    
    return appDataObject;
  } catch(error) {
    console.error('Error in updateDeveloperAppData function', error);
  }
}



// Used in forge-client, publisher dashboard page
Parse.Cloud.define("getTopPluginsList", async (request) => {
  const { parseServerSiteId, limit = 3, sortBy = 'installsCount' } = request.params;
  try {
    const apps = await getTopPluginsList( parseServerSiteId, sortBy, limit );

    return { status: 'success', apps };
  } catch (error) {
    console.error('inside getTopPluginsList', error);
    return { status: 'error', error };
  }
});


const getTopPluginsList = async(parseServerSiteId, sortBy, limit) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }
    
    const DEVELOPER_APP_DATA_MODEL_NAME = `ct____${siteNameId}____Developer_App_Data`;
    const dataQuery = new Parse.Query(DEVELOPER_APP_DATA_MODEL_NAME);
    dataQuery.equalTo('t__status', 'Published');
    if (sortBy === 'installsCount') {
      dataQuery.descending('Installs_Count');
    } else if (sortBy === 'rating') {
      dataQuery.descending('Rating');
    }

    dataQuery.limit(limit);
    const dataObjects = await dataQuery.find();


    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;
    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.include('Data');
    query.include('Content');
    query.include('Content.Key_Image');
    query.containedIn('Data', dataObjects);
    
    const appObjects = await query.find({ useMasterKey: true });

    const lst = await Promise.all(
      appObjects.map(async(appObject) => {       
        const developerContent = getAppContentFromAppObject(appObject);
        const developerData = getAppDataFromAppObject(appObject);
        return {
          name: appObject.get('Name'),
          id: appObject.id,
          slug: appObject.get('Slug'),
          url: appObject.get('URL'),
          developerContent,
          developerData,
        };
      })
    );
    return lst;

  } catch(error) {
    console.error('inside getTopPluginsList', error);
    throw error;
  }
}

// Used in forge-client, publisher dashboard to provide plugin statistics(by status)
Parse.Cloud.define("getPluginsListData", async (request) => {
  const { parseServerSiteId } = request.params;
  try {
    const apps = await getPluginsListData(parseServerSiteId);

    return { status: 'success', apps };
  } catch (error) {
    console.error('inside getPluginsListData', error);
    return { status: 'error', error };
  }
});


const getPluginsListData = async(parseServerSiteId) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_APP_MODEL_NAME = `ct____${siteNameId}____Developer_App`;

    const query = new Parse.Query(DEVELOPER_APP_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.include('Data');
    const appObjects = await query.find();

    const lst = appObjects.map((appObject) => {
      const appData = getAppDataFromAppObject(appObject);

      return {
        name: appObject.get('Name'),
        id: appObject.id,
        slug: appObject.get('Slug'),
        url: appObject.get('URL'),
        appData,
      };
    });
    return lst;

  } catch(error) {
    console.error('inside getPluginsListData', error);
    throw error;
  }
}



// Used in forge-client
Parse.Cloud.define('getDevelopersList', async(request) => {
  try {
    const { parseServerSiteId, verified } = request.params;
    const developersList = await getDevelopersList(parseServerSiteId, verified);
    return { status: 'success', developersList };
  } catch (error) {
    console.error('Error in getDevelopersList', error);
    return { status: 'error', error };
  }
});


const getDevelopersList = async(parseServerSiteId, verified = null) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    // Model related data preparation
    const DEVELOPER_MODEL_NAME = `ct____${siteNameId}____Developer`;
    const developerQuery = new Parse.Query(DEVELOPER_MODEL_NAME);
    developerQuery.equalTo('t__status', 'Published');
    if (verified !== null) {
      developerQuery.equalTo('Verified', verified);
    }
    const results = await developerQuery.find();

    const list = results.map(developer => (
      {
        id: developer.id,
        slug: developer.get('Slug') || '',
        name: developer.get('Name'),
        verified: developer.get('Verified') || false,
        company: developer.get('Company') || '',
        country: developer.get('Country') || '',
        website: developer.get('Website') || '',
        email: developer.get('Email') || '',
        isActive: developer.get('IsActive') || false,
        updatedAt: developer.get('updatedAt')
      }
    ));
    return list;

  } catch(error) {
    console.error("inside getDevelopersList function", error);
    throw error;
  }
}
// used in forge-client
Parse.Cloud.define("getDeveloperDetail", async (request) => {
  const { parseServerSiteId, developerId } = request.params;
  try {
    const developer = await getDeveloperDetail(parseServerSiteId, developerId);
    return { status: 'success', developer };
  } catch (error) {
    console.error('Error in getDeveloperDetail', error);
    return { status: 'error', error };
  }
});

const getDeveloperDetail = async(parseServerSiteId, developerId) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId= await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    // get site name Id and generate MODEL names based on that
    const DEVELOPER_MODEL_NAME = `ct____${siteNameId}____Developer`;
    const developerQuery = new Parse.Query(DEVELOPER_MODEL_NAME);
    developerQuery.equalTo('objectId', developerId);
    developerQuery.equalTo('t__status', 'Published');
    const developerObject = await developerQuery.first();
    
    if (!developerObject) return null;
    
    const filter = { developer: [developerId] };
    const appsList = await getPluginsList(parseServerSiteId, filter);

    return {
      id: developerObject.id,
      name: developerObject.get('Name'),
      verified: developerObject.get('Verified') || false,
      company: developerObject.get('Company') || '',
      website: developerObject.get('Website') || '',
      email: developerObject.get('Email') || '',
      country: developerObject.get('Country') || '',
      isActive: developerObject.get('IsActive') || false,
      appsList
    };

  } catch(error) {
    console.error('Error in getDeveloperDetail function', error);
    throw error;
  }
}


// Called in forge-client
Parse.Cloud.define("getCategories", async (request) => {
  const { parseServerSiteId } = request.params;
  try {
    const categories = await getCategories(parseServerSiteId);
    return { status: 'success', categories };
  } catch (error) {
    console.error('inside getCategories', error);
    return { status: 'error', error };
  }
});


const getCategories = async(parseServerSiteId) => {
  try {
    const siteNameId = await getSiteNameId(parseServerSiteId);
    const CATEGORY_MODEL_NAME = `ct____${siteNameId}____Category`;
    const query = new Parse.Query(CATEGORY_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    const categoryObjects = await query.find();
    if (categoryObjects && categoryObjects.length > 0) {
      return categoryObjects.map((object) => ({
        id: object.id,
        name: object.get('Name'),
        slug: object.get('Slug'),
      }));
    }
    return [];
  } catch(error) {
    console.error('Error in getCategories', error);
  }
}


// Called in forge-client, plugin publish flow / capabilities dropdown
Parse.Cloud.define("getCapabilities", async (request) => {
  const { parseServerSiteId } = request.params;
  try {
    const capabilities = await getCapabilities(parseServerSiteId);
    return { status: 'success', capabilities };
  } catch (error) {
    console.error('inside getCapabilities', error);
    return { status: 'error', error };
  }
});


const getCapabilities = async(parseServerSiteId) => {
  try {
    const siteNameId = await getSiteNameId(parseServerSiteId);
    const CAPABILITY_MODEL_NAME = `ct____${siteNameId}____Capability`;
    const query = new Parse.Query(CAPABILITY_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    const capabilityObjects = await query.find();
    if (capabilityObjects && capabilityObjects.length > 0) {
      return capabilityObjects.map((object) => ({
        id: object.id,
        name: object.get('Name'),
        slug: object.get('Slug'),
        description: object.get('Description'),
      }));
    }
    return [];
  } catch(error) {
    console.error('Error in getCapabilities', error);
  }
}

// Used in forge-client, publisher dashboard / policies page
Parse.Cloud.define('getPoliciesList', async(request) => {
  const { parseServerSiteId } = request.params;
  try {
    const policiesList = await getPoliciesList(parseServerSiteId);
    return { status: 'success', policiesList };
  } catch (error) {
    console.error('inside policiesList', error);
    return { status: 'error', error };
  }
});

const getPoliciesList = async(parseServerSiteId) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    // Model related data preparation
    const POLICY_MODEL_NAME = `ct____${siteNameId}____Policy`;
    const policyQuery = new Parse.Query(POLICY_MODEL_NAME);
    policyQuery.equalTo('t__status', 'Published');
    const results = await policyQuery.find();

    const list = results.map(policy => (
      {
        id: policy.id,
        name: policy.get('Policy_Name') || '',
        updatedAt: policy.get('updatedAt') || '',
        EvalSafe_Pass_Max: policy.get('Eval_Safe_Pass_Max'),
        EvalSafe_Pass_Min: policy.get('EvalSafe_Pass_Min'),
        EvalSafe_Warning_Max: policy.get('EvalSafe_Warning_Max'),
        EvalSafe_Warning_Min: policy.get('EvalSafe_Warning_Min'),
        EvalSafe_Fail_Max: policy.get('EvalSafe_Fail_Max'),
        EvalSafe_Fail_Min: policy.get('EvalSafe_Fail_Min'),
        RequireSSL: policy.get('RequireSSL'),
        RequireForceSSL: policy.get('RequireForceSSL'),
        AllowExternalNetworkRequest: policy.get('AllowExternalNetworkRequest'),
        ExternalRequestAllowList: policy.get('ExternalRequestAllowList'),
        ExternalRequestsBlockList: policy.get('ExternalRequestsBlockList'),
        AllowInsecureNetworkURLs: policy.get('AllowInsecureNetworkURLs'),
        Bandwidth_Day_Usage_Limit: policy.get('Bandwidth_Day_Usage_Limit'),
        BandWidth_Week_Usage_Limit: policy.get('BandWidth_Week_Usage_Limit'),
        Forms_Allowed: policy.get('Forms_Allowed'),
        Forms_Limit: policy.get('Forms_Limit'),
        Allow_Collaborators: policy.get('Allow_Collaborators'),
        Collaborator_Limit: policy.get('Collaborator_Limit'),
        Media_Microphone_Allowed: policy.get('Media_Microphone_Allowed'),
        Media_Camera_Allowed: policy.get('Media_Camera_Allowed')
      }
      ));
    return list;

  } catch(error) {
    console.error("inside getPoliciesList function", error);
    throw error;
  }
}

// Called in forge-client
Parse.Cloud.define('getLatestSDK', async(request) => {
  const { parseServerSiteId } = request.params;
  try {
    const data = await getLatestSDK(parseServerSiteId);
    return { status: 'success', data };
  } catch (error) {
    console.error('inside getLatestSDK', error);
    return { status: 'error', error };
  }
});

const getLatestSDK = async (parseServerSiteId) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const SDK_MODEL_NAME = `ct____${siteNameId}____SDK`;

    const sdkQuery = new Parse.Query(SDK_MODEL_NAME);
    sdkQuery.equalTo('t__status', 'Published');
    sdkQuery.descending('updatedAt');
    const sdkObject = await sdkQuery.first();
    if (sdkObject)
      return {
        id: sdkObject.id,
        version: sdkObject.get('Version'),
        src: sdkObject.get('File')._url,
      }
    return null;
  } catch(error) {
    console.error('inside getLatestSDK', error);
    throw error;
  }
}

// Called in forge-client
Parse.Cloud.define("uploadFile", async (request) => {
  try {
    const { fileName, base64 } = request.params;
    const parseFile = new Parse.File(fileName, { base64 });
    await parseFile.save({ useMasterKey: true });
    return { status: 'success', parseFile };
  } catch(error) {
    console.error('Error in uploadFile', error);
  }

});

// Called in forge-client
Parse.Cloud.define("destroyFile", async (request) => {
  try {
    const { file } = request.params;
    await file.destroy({ useMasterKey: true });
    return { status: 'success' };
  } catch(error) {
    console.error('Error in destroyFile', error);
  }
});

// Called in forge-client, EMPTY for now
Parse.Cloud.define("removeApp", async (request) => {
  try {
    const { parseServerSiteId, appId } = request.params;
    const result = await removeApp(parseServerSiteId, appId);
    return { status: 'success', result };
  } catch(error) {
    console.error('Error in removeApp', error);
  }
});

const removeApp = async(appId) => {
  try {
    console.log('inside remove app', appId)
  } catch(error) {
    console.error('inside removeApp function', error);
    throw error;
  }
}

// Called in forge-client, publisher dashboard
Parse.Cloud.define("removeDeveloper", async (request) => {
  try {
    const { parseServerSiteId, developerId } = request.params;
    const result = await removeDeveloper(parseServerSiteId, developerId);
    return { status: 'success', result };
  } catch(error) {
    console.error('Error in removeDeveloper', error);
  }
});

const removeDeveloper = async(parseServerSiteId, developerId) => {
  try {
    // get site name Id and generate MODEL names based on that
    const siteNameId = await getSiteNameId(parseServerSiteId);
    if (siteNameId === null) {
      throw { message: 'Invalid siteId' };
    }

    const DEVELOPER_MODEL_NAME = `ct____${siteNameId}____Developer`;
    const query = new Parse.Query(DEVELOPER_MODEL_NAME);
    query.equalTo('t__status', 'Published');
    query.equalTo('objectId', developerId.toString());
        
    const developer = await query.first();

    if (developer) {
      developer.destroy({useMasterKey: true});
    }
  } catch(error) {
    console.error('inside removeDeveloper function', error);
    throw error;
  }
}