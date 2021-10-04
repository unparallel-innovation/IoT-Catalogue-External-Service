
function getConf(socketAddress){
    let config
    if(process.env.development){

        config =     {
            "socketAddress": "ws://127.0.0.1:3000"
        }
    }



    if(process.env.config)   {
        config = JSON.parse(process.env.config)
    }

    if(instanceConfig){
        config = instanceConfig
    }
    if(config){
        return config
    }

    if(!config){
        throw "Missing config"
    }
}





exports.getConf = getConf
